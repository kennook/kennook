'use client';

/**
 * Live tail / replay of a job's output via Server-Sent Events.
 *
 * - On mount (or jobId change): opens EventSource to /api/admin/jobs/<id>/stream
 * - Server first sends `snapshot` (the full buffered output so far)
 * - Then streams `output` chunks while the job runs
 * - `finished` event ends the stream; we keep the buffer visible
 *
 * Auto-scrolls to the bottom unless the user has scrolled up
 * (sticky-bottom UX, same pattern as YouTube live chat).
 */

import { useEffect, useRef, useState } from 'react';
import type {
  ProgressPayload,
  ProgressEnvelope,
  RecentItem,
} from '@/server/admin/progress-protocol';
import { ProgressStrip } from './ProgressStrip';

interface Snapshot {
  status: string;
  exitCode: number | null;
  output: string;
  progress: ProgressPayload | null;
  recent: RecentItem[];
}
interface FinishedPayload {
  status: string;
  exitCode: number | null;
}

export function OutputPanel({
  jobId,
  onClose,
}: {
  jobId: number;
  onClose: () => void;
}) {
  const [output, setOutput] = useState('');
  const [statusInfo, setStatusInfo] = useState<{ status: string; exitCode: number | null } | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [connected, setConnected] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stickyRef = useRef(true);

  // Connection generation — bumping this triggers the effect to
  // tear down and recreate the EventSource. Used by the tab-focus
  // reconnect: if the browser throttled the connection (or HMR /
  // network blip broke it), focus = reconnect = fresh snapshot.
  const [connGen, setConnGen] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    setOutput('');
    setStatusInfo(null);
    setProgress(null);
    setRecent([]);
    setConnected(false);
    stickyRef.current = true;
    finishedRef.current = false;

    const es = new EventSource(`/api/admin/jobs/${jobId}/stream`);
    esRef.current = es;
    es.addEventListener('snapshot', (e) => {
      try {
        const snap = JSON.parse((e as MessageEvent).data) as Snapshot;
        setOutput(snap.output);
        setStatusInfo({ status: snap.status, exitCode: snap.exitCode });
        setProgress(snap.progress);
        setRecent(snap.recent ?? []);
        setConnected(true);
      } catch { /* ignore */ }
    });
    es.addEventListener('output', (e) => {
      const chunk = (e as MessageEvent).data as string;
      // SSE collapses each `data:` line + implicit '\n' — restore the
      // trailing newline that the writer stripped for the wire.
      setOutput((prev) => prev + chunk + '\n');
    });
    es.addEventListener('progress', (e) => {
      try {
        const env = JSON.parse((e as MessageEvent).data) as ProgressEnvelope;
        setProgress(env.progress);
        setRecent(env.recent);
      } catch { /* ignore */ }
    });
    es.addEventListener('finished', (e) => {
      try {
        const fin = JSON.parse((e as MessageEvent).data) as FinishedPayload;
        setStatusInfo(fin);
      } catch { /* ignore */ }
      finishedRef.current = true;
      es.close();
    });
    es.addEventListener('heartbeat', () => { /* keepalive */ });
    es.onerror = () => {
      setConnected(false);
      // Don't auto-close; the EventSource will retry on its own. If the
      // job is already done, the next reconnect will get the snapshot
      // + immediate finished event and close cleanly.
    };

    return () => es.close();
  }, [jobId, connGen]);

  // Defense in depth: when the tab regains focus (or visibility),
  // force a reconnect. SSE in Next.js dev mode can drift after HMR
  // or if the browser throttled the connection during inactivity;
  // a fresh snapshot is cheap and guarantees the UI catches up.
  useEffect(() => {
    const reconnect = () => {
      if (finishedRef.current) return;          // already done; don't churn
      if (document.visibilityState !== 'visible') return;
      setConnGen((g) => g + 1);
    };
    window.addEventListener('focus', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      window.removeEventListener('focus', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
    };
  }, []);

  // Auto-scroll to bottom when sticky.
  useEffect(() => {
    if (!stickyRef.current) return;
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  function onScroll() {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    stickyRef.current = atBottom;
  }

  const statusLabel = statusInfo?.status ?? (connected ? 'streaming' : 'connecting');
  const statusColor =
    statusInfo?.status === 'completed' ? 'text-emerald-400'
    : statusInfo?.status === 'failed' ? 'text-red-400'
    : statusInfo?.status === 'canceled' ? 'text-amber-400'
    : statusInfo?.status === 'running' ? 'text-emerald-300 animate-pulse'
    : 'text-zinc-400';

  return (
    <div className="rounded-lg ring-1 ring-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2
                      bg-zinc-900 border-b border-zinc-800">
        <div className={`text-[11px] uppercase tracking-wider ${statusColor}`}>
          {statusLabel}
          {statusInfo?.exitCode !== null && statusInfo?.exitCode !== undefined && (
            <span className="text-zinc-600 ml-2 font-mono">exit {statusInfo.exitCode}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-xs text-zinc-500 hover:text-zinc-200 transition"
        >
          close panel
        </button>
      </div>
      {(statusInfo?.status === 'failed' || statusInfo?.status === 'canceled') && (
        <div className={`px-3 py-2 text-xs border-b
                         ${statusInfo.status === 'failed'
                           ? 'bg-red-950/40 border-red-900 text-red-200'
                           : 'bg-amber-950/30 border-amber-900 text-amber-200'}`}>
          <strong className="font-medium">
            Job {statusInfo.status}
            {statusInfo.exitCode !== null && ` (exit ${statusInfo.exitCode})`}.
          </strong>
          {' '}See the script output below for details.
        </div>
      )}
      {progress && (
        <div className="px-3 py-3 border-b border-zinc-800">
          <ProgressStrip
            progress={progress}
            recent={recent}
            isRunning={statusInfo?.status === 'running'}
          />
        </div>
      )}
      <pre
        ref={preRef}
        onScroll={onScroll}
        className="px-3 py-2 text-[11px] leading-relaxed font-mono text-zinc-300
                   max-h-[400px] min-h-[200px] overflow-auto whitespace-pre-wrap break-words"
      >
        {output || (connected ? '(no output yet)' : 'Connecting…')}
      </pre>
    </div>
  );
}
