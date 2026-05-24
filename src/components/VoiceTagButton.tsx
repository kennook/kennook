'use client';

/**
 * Hold-to-record voice tagging.
 *
 * The core lifecycle (mic acquisition → MediaRecorder → upload → tag
 * commit) lives in `useVoiceTagger` so the maxed-mode toolbar button
 * and the keyboard shortcut can drive the same flow without
 * duplicating state machines.
 *
 * `VoiceTagButton` (this file's default export-shape) is the sidebar
 * pill: full-width, labeled, with inline status messages. The maxed
 * toolbar uses `MaxedVoiceTagButton` (an icon-only variant) and the
 * shortcut goes through the hook directly.
 *
 * Why hold-to-record (vs. tap-to-toggle): mic stays live ONLY while
 * the button is depressed. There's no scenario where Kennook is
 * listening without an explicit, currently-held gesture. Release →
 * recorder stops, stream tracks are stopped, the browser's mic
 * indicator disappears.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

export type VoiceTagStatus =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'processing' }
  | { kind: 'done'; tags: string[]; transcript: string; peakAmplitude?: number }
  | { kind: 'error'; message: string };

interface UseVoiceTaggerOptions {
  uuid: string;
  workspaceSlug: string;
  /** Called after tags are committed; lets parent invalidate caches. */
  onCommitted?: (tags: string[]) => void;
}

export interface VoiceTagger {
  status: VoiceTagStatus;
  start: () => void;
  stop: () => void;
}

/**
 * Imperative recording lifecycle. Call `start()` on press / keydown,
 * `stop()` on release / keyup. The hook handles everything else: mic
 * acquisition, MediaRecorder events, server round-trip, tag commits,
 * and the status state machine. Same uuid/workspaceSlug pair → same
 * commit destination, no matter who's driving.
 */
export function useVoiceTagger({
  uuid,
  workspaceSlug,
  onCommitted,
}: UseVoiceTaggerOptions): VoiceTagger {
  const [status, setStatus] = useState<VoiceTagStatus>({ kind: 'idle' });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Guard against double-stop (e.g. pointerup + keyup firing in the
  // same gesture if both affordances trigger).
  const submittedRef = useRef(false);
  // Snapshot the latest status into a ref so start()/stop() can read
  // it without becoming stale closures.
  const statusRef = useRef(status);
  statusRef.current = status;

  const addTag = trpc.media.addUserTag.useMutation();

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Always tear down the mic stream on unmount — don't leak the
  // browser's permission indicator if the viewer closes mid-record.
  useEffect(() => () => stopStream(), [stopStream]);

  const uploadAndCommit = useCallback(async (blob: Blob) => {
    if (blob.size === 0) {
      setStatus({ kind: 'error', message: 'No audio captured' });
      return;
    }
    setStatus({ kind: 'processing' });
    let payload: { transcript: string; tags: string[]; peakAmplitude?: number };
    try {
      const res = await fetch('/api/voice-tag', {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(errText || `Voice-tag request failed (${res.status})`);
      }
      payload = await res.json();
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (payload.tags.length === 0) {
      setStatus({
        kind: 'done',
        tags: [],
        transcript: payload.transcript,
        peakAmplitude: payload.peakAmplitude,
      });
      return;
    }

    // Sequential to avoid SQLITE_BUSY on the shared media_tags index.
    const committed: string[] = [];
    for (const tag of payload.tags) {
      try {
        await addTag.mutateAsync({ uuid, workspaceSlug, name: tag });
        committed.push(tag);
      } catch {
        // duplicates / length errors — skip and continue
      }
    }
    onCommitted?.(committed);
    setStatus({
      kind: 'done',
      tags: committed,
      transcript: payload.transcript,
    });
  }, [addTag, uuid, workspaceSlug, onCommitted]);

  const start = useCallback(() => {
    const current = statusRef.current.kind;
    if (current === 'recording' || current === 'processing') return;
    submittedRef.current = false;
    chunksRef.current = [];

    // navigator.mediaDevices is gated behind a secure context. Plain
    // http:// (other than localhost) returns `undefined`; catch up
    // front so the user sees an actionable message.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus({
        kind: 'error',
        message: window.isSecureContext
          ? 'Mic API unavailable in this browser.'
          : 'Mic needs HTTPS — open Kennook via https:// (or http://localhost).',
      });
      return;
    }

    setStatus({ kind: 'recording' });

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Mic permission denied',
        });
        return;
      }
      // The user may have released before getUserMedia resolved — in
      // which case statusRef is no longer 'recording'. Abort cleanly.
      if (statusRef.current.kind !== 'recording') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      // Chrome → webm/opus, Safari → mp4/aac. Server's ffmpeg sniffs
      // the container so we don't need to be picky.
      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        '',
      ];
      const mimeType = mimeCandidates.find((m) =>
        m === '' || MediaRecorder.isTypeSupported(m),
      ) ?? '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stopStream();
        if (submittedRef.current) return;
        submittedRef.current = true;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        void uploadAndCommit(blob);
      };

      recorder.start();
    })();
  }, [stopStream, uploadAndCommit]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      setStatus({ kind: 'processing' });
    } else {
      stopStream();
      if (statusRef.current.kind === 'recording') setStatus({ kind: 'idle' });
    }
  }, [stopStream]);

  // Auto-fade transient terminal states so the UI doesn't get cluttered.
  useEffect(() => {
    if (status.kind === 'done' || status.kind === 'error') {
      const t = setTimeout(() => setStatus({ kind: 'idle' }), 4000);
      return () => clearTimeout(t);
    }
  }, [status]);

  return { status, start, stop };
}

// ─── Sidebar button (full-width, labeled, with inline status) ─────────

interface SidebarProps {
  uuid: string;
  workspaceSlug: string;
  onCommitted?: (tags: string[]) => void;
}

export function VoiceTagButton({ uuid, workspaceSlug, onCommitted }: SidebarProps) {
  const { status, start, stop } = useVoiceTagger({ uuid, workspaceSlug, onCommitted });
  const recording = status.kind === 'recording';
  const processing = status.kind === 'processing';

  return (
    <div className="mt-1.5">
      <button
        type="button"
        disabled={processing}
        onPointerDown={(e) => { e.preventDefault(); start(); }}
        onPointerUp={stop}
        onPointerLeave={() => { if (recording) stop(); }}
        onPointerCancel={() => { if (recording) stop(); }}
        className={`w-full text-[11px] rounded px-2 py-1.5 border transition
                    flex items-center justify-center gap-1.5 select-none
                    ${recording
                      ? 'bg-red-950/60 border-red-700/60 text-red-200'
                      : processing
                        ? 'bg-zinc-900 border-zinc-800 text-zinc-500'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100'}
                    disabled:cursor-wait`}
        title="Hold to record voice tags"
      >
        <MicIcon recording={recording} />
        <span>
          {recording ? 'Listening… release to tag'
            : processing ? 'Transcribing…'
            : 'Hold to tag with voice'}
        </span>
      </button>

      <VoiceTagStatusLine status={status} />
    </div>
  );
}

/**
 * Inline status line for the sidebar: surfaces committed tags, no-noun
 * outcomes, mic-too-quiet diagnostics, and errors. Reused by the maxed
 * HUD via the same status object.
 */
export function VoiceTagStatusLine({ status }: { status: VoiceTagStatus }) {
  if (status.kind === 'done' && status.tags.length > 0) {
    return (
      <div className="text-[10px] text-emerald-400 mt-1 leading-snug">
        Added: {status.tags.join(', ')}
      </div>
    );
  }
  if (status.kind === 'done' && status.tags.length === 0) {
    return (
      <div className="text-[10px] text-zinc-400 mt-1 leading-snug">
        {status.transcript
          ? <>No nouns in: &ldquo;{status.transcript}&rdquo;</>
          : status.peakAmplitude !== undefined && status.peakAmplitude < 0.05
            ? <>Mic too quiet (peak {status.peakAmplitude.toFixed(3)}) — speak closer or check input level.</>
            : <>No speech detected.</>}
      </div>
    );
  }
  if (status.kind === 'error') {
    return (
      <div className="text-[10px] text-red-400 mt-1 leading-snug">
        {status.message}
      </div>
    );
  }
  return null;
}

export function MicIcon({ recording }: { recording: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.5"
         className={recording ? 'animate-pulse' : ''}>
      <rect x="6" y="2" width="4" height="8" rx="2" />
      <path d="M3 8a5 5 0 0 0 10 0M8 13v2" strokeLinecap="round" />
    </svg>
  );
}
