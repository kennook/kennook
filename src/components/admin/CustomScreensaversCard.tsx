'use client';

/**
 * Admin control for custom screensaver clips (mounted on /admin/settings). Drop
 * or choose videos; each POSTs to /api/admin/screensaver/upload, which stores it
 * and transcodes it to web-safe MP4 in the background. The list polls for the
 * processing → ready/failed flip. When any clip is `ready` it replaces the
 * built-in stock footage in the screensaver rotation across every screen.
 */

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

/** 720p variant URL for a ready clip — small enough to preview inline. */
function previewUrl(id: string): string {
  return `/api/screensaver/media/${id}/720`;
}

// Playback speeds offered in the dropdown (same values as SCREENSAVER_SPEEDS on
// the server), ascending.
const SPEEDS = [0.25, 0.5, 0.75, 1, 2, 3] as const;
const fmtSpeed = (s: number) => `${s}×`;

type PendingStatus = 'uploading' | 'error';
interface PendingRow {
  key: string;
  name: string;
  status: PendingStatus;
  error?: string;
}

let counter = 0;

export function CustomScreensaversCard() {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Rows for in-flight uploads only; once the server registers a clip it shows
  // up in the polled `list` (as `processing`), so we drop the local row then.
  const [pending, setPending] = useState<PendingRow[]>([]);

  const list = trpc.screensaver.list.useQuery(undefined, {
    // Poll while anything is still transcoding OR building its loop, so the
    // "processing" states clear on their own.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c) => c.status === 'processing' || c.loopStatus === 'processing')
        ? 2000 : false,
  });
  const clips = list.data ?? [];
  const readyCount = clips.filter((c) => c.status === 'ready').length;
  const enabledReadyCount = clips.filter((c) => c.status === 'ready' && c.enabled !== false).length;

  const remove = trpc.screensaver.remove.useMutation({
    onSuccess: () => utils.screensaver.list.invalidate(),
  });
  const setEnabled = trpc.screensaver.setEnabled.useMutation({
    // Optimistic flip so the toggle feels instant.
    onMutate: async ({ id, enabled }) => {
      await utils.screensaver.list.cancel();
      const prev = utils.screensaver.list.getData();
      utils.screensaver.list.setData(undefined, (old) =>
        old?.map((c) => (c.id === id ? { ...c, enabled } : c)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.screensaver.list.setData(undefined, ctx.prev); },
    onSettled: () => utils.screensaver.list.invalidate(),
  });
  const setLoop = trpc.screensaver.setLoop.useMutation({
    onMutate: async ({ id, loop }) => {
      await utils.screensaver.list.cancel();
      const prev = utils.screensaver.list.getData();
      utils.screensaver.list.setData(undefined, (old) =>
        old?.map((c) => {
          if (c.id !== id) return c;
          if (!loop) return { ...c, loop: false };
          // Enabling: instant if already built, else show "preparing…".
          return { ...c, loop: true, loopStatus: c.loopStatus === 'ready' ? 'ready' : 'processing' };
        }),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.screensaver.list.setData(undefined, ctx.prev); },
    onSettled: () => utils.screensaver.list.invalidate(),
  });
  const setSpeed = trpc.screensaver.setSpeed.useMutation({
    onMutate: async ({ id, speed }) => {
      await utils.screensaver.list.cancel();
      const prev = utils.screensaver.list.getData();
      utils.screensaver.list.setData(undefined, (old) =>
        old?.map((c) => (c.id === id ? { ...c, speed } : c)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.screensaver.list.setData(undefined, ctx.prev); },
    onSettled: () => utils.screensaver.list.invalidate(),
  });
  const setOnly = trpc.screensaver.setOnly.useMutation({
    // Optimistically flip everything: only this one on.
    onMutate: async ({ id }) => {
      await utils.screensaver.list.cancel();
      const prev = utils.screensaver.list.getData();
      utils.screensaver.list.setData(undefined, (old) =>
        old?.map((c) => ({ ...c, enabled: c.id === id })),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.screensaver.list.setData(undefined, ctx.prev); },
    onSettled: () => utils.screensaver.list.invalidate(),
  });

  async function uploadOne(key: string, file: File) {
    const form = new FormData();
    form.set('file', file);
    form.set('name', file.name.replace(/\.[^.]+$/, ''));
    try {
      const res = await fetch('/api/admin/screensaver/upload', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      // Registered server-side — drop the local row and let the list take over.
      setPending((p) => p.filter((x) => x.key !== key));
      await utils.screensaver.list.invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPending((p) => p.map((x) => (x.key === key ? { ...x, status: 'error', error: msg } : x)));
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const queued = Array.from(files).map((file) => ({ key: `p${counter++}`, file }));
    if (queued.length === 0) return;
    // Show every picked file as pending up front.
    setPending((p) => [
      ...queued.map((q) => ({ key: q.key, name: q.file.name, status: 'uploading' as const })),
      ...p,
    ]);
    // Upload a few at a time: several stream together, but capped so a big batch
    // doesn't open a flood of concurrent (up to 1 GB) transfers. Transcoding is
    // serialized server-side regardless.
    const CONCURRENCY = 3;
    let next = 0;
    const worker = async () => {
      while (next < queued.length) {
        const { key, file } = queued[next++];
        await uploadOne(key, file);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queued.length) }, worker));
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-2xl mt-6">
      <h2 className="text-sm font-medium text-zinc-200 mb-1">Custom screensaver</h2>
      <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
        Upload your own clips to play as the walk-away screensaver. Any video
        works (mp4, mov, m4v, webm) — it’s converted to a web-friendly format
        automatically. Hover a clip to preview it, then enable the ones you want:
        turn on several and they rotate (a different one per screen on a wall), or
        just one to pin it. With none enabled, the built-in screensaver plays.
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center transition
          ${dragOver
            ? 'border-emerald-600 bg-emerald-950/20'
            : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/40'}`}
      >
        <div className="text-sm text-zinc-300">Drop videos here, or click to choose</div>
        <div className="text-[11px] text-zinc-500 mt-1">
          Pick or drop several at once — converted in the background, up to 1 GB each.
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {(pending.length > 0 || clips.length > 0) && (
        <div className="mt-4 space-y-3">
          {pending.length > 0 && (
            <ul className="space-y-1">
              {pending.map((p) => (
                <li
                  key={p.key}
                  className="flex items-center justify-between gap-3 text-xs px-3 py-2 rounded
                             bg-zinc-900/50 ring-1 ring-zinc-800"
                >
                  <span className="text-zinc-300 truncate">{p.name}</span>
                  {p.status === 'uploading'
                    ? <span className="text-zinc-500 shrink-0">uploading…</span>
                    : <span className="text-red-300 shrink-0" title={p.error}>failed</span>}
                </li>
              ))}
            </ul>
          )}

          {clips.length > 0 && (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {clips.map((c) => {
                const isReady = c.status === 'ready';
                const on = c.enabled !== false;
                const loopOn = c.loop === true && c.loopStatus === 'ready';
                const loopBusy = c.loopStatus === 'processing';
                return (
                  <li
                    key={c.id}
                    className="rounded-lg ring-1 ring-zinc-800 bg-zinc-900/50 overflow-hidden"
                  >
                    {/* Big preview, with delete tucked into the corner. */}
                    <div className="relative">
                      <ClipPreview id={c.id} ready={isReady} speed={c.speed ?? 1} />
                      <button
                        onClick={() => remove.mutate({ id: c.id })}
                        disabled={remove.isPending}
                        title="Delete clip"
                        aria-label="Delete clip"
                        className="absolute top-1.5 right-1.5 w-7 h-7 flex items-center justify-center
                                   rounded-full bg-black/50 backdrop-blur text-zinc-300
                                   hover:text-red-300 transition disabled:opacity-40"
                      >
                        ×
                      </button>
                    </div>

                    {/* Compact footer: name + status, then the controls. */}
                    <div className="px-2.5 py-2 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] text-zinc-200 truncate">{c.name}</div>
                        <div className="text-[10px] leading-tight mt-0.5">
                          {c.status === 'processing' && <span className="text-amber-300">converting…</span>}
                          {isReady && (
                            <span className={on ? 'text-emerald-300' : 'text-zinc-500'}>
                              {on ? (enabledReadyCount > 1 ? 'in rotation' : 'active') : 'disabled'}
                            </span>
                          )}
                          {isReady && loopBusy && <span className="text-amber-300"> · preparing loop…</span>}
                          {isReady && loopOn && <span className="text-zinc-500"> · loop</span>}
                          {isReady && c.loopStatus === 'failed' && <span className="text-red-300"> · loop failed</span>}
                          {c.status === 'failed' && <span className="text-red-300" title={c.error}>failed</span>}
                        </div>
                      </div>

                      {isReady && readyCount > 1 && !(on && enabledReadyCount === 1) && (
                        <button
                          onClick={() => setOnly.mutate({ id: c.id })}
                          disabled={setOnly.isPending}
                          title="Play only this one — disable the others"
                          className="text-[11px] text-zinc-500 hover:text-emerald-300 transition
                                     disabled:opacity-40 shrink-0"
                        >
                          Only
                        </button>
                      )}
                      {isReady && (() => {
                        const speed = c.speed ?? 1;
                        return (
                          <select
                            value={speed}
                            onChange={(e) => setSpeed.mutate({ id: c.id, speed: Number(e.target.value) })}
                            disabled={setSpeed.isPending}
                            aria-label="Playback speed"
                            title="Playback speed"
                            className={`shrink-0 text-[11px] font-medium tabular-nums rounded bg-zinc-900
                                        ring-1 ring-zinc-700 px-1 py-1 outline-none cursor-pointer
                                        focus:ring-zinc-500 disabled:opacity-40
                                        ${speed !== 1 ? 'text-emerald-300' : 'text-zinc-300'}`}
                          >
                            {SPEEDS.map((s) => (
                              <option key={s} value={s} className="bg-zinc-900 text-zinc-200">
                                {fmtSpeed(s)}
                              </option>
                            ))}
                          </select>
                        );
                      })()}
                      {isReady && (
                        <button
                          onClick={() => setLoop.mutate({ id: c.id, loop: !loopOn })}
                          disabled={setLoop.isPending || loopBusy}
                          aria-pressed={loopOn}
                          title={
                            loopOn ? 'Seamless loop on — tap to turn off'
                              : loopBusy ? 'Preparing seamless loop…'
                              : c.loopStatus === 'failed' ? 'Loop build failed — tap to retry'
                              : 'Loop seamlessly (plays forward then reversed, back to the first frame)'
                          }
                          className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition
                                      disabled:opacity-40
                                      ${loopOn ? 'text-emerald-300'
                                        : loopBusy ? 'text-amber-300'
                                        : 'text-zinc-500 hover:text-zinc-300'}`}
                        >
                          <LoopIcon />
                        </button>
                      )}
                      {isReady && (
                        <Toggle
                          on={on}
                          disabled={setEnabled.isPending}
                          label={`${c.name} in rotation`}
                          onChange={(v) => setEnabled.mutate({ id: c.id, enabled: v })}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Small inline preview. Ready clips play the 720p variant on hover (muted,
 *  looping); non-ready ones show a placeholder. Tap also toggles play (touch). */
function ClipPreview({ id, ready, speed }: { id: string; ready: boolean; speed: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  // Reflect the clip's playback speed in the preview so a change is visible.
  // Applied live (this fires when `speed` changes) and again on load below.
  useEffect(() => { if (ref.current) ref.current.playbackRate = speed; }, [speed]);
  if (!ready) return <div className="w-full aspect-video bg-zinc-800" />;
  return (
    <video
      ref={ref}
      src={previewUrl(id)}
      muted
      loop
      playsInline
      preload="metadata"
      title="Hover to preview"
      onLoadedMetadata={(e) => { e.currentTarget.playbackRate = speed; }}
      onMouseEnter={() => { void ref.current?.play().catch(() => {}); }}
      onMouseLeave={() => { const v = ref.current; if (v) { v.pause(); v.currentTime = 0; } }}
      onClick={() => {
        const v = ref.current;
        if (!v) return;
        if (v.paused) void v.play().catch(() => {}); else v.pause();
      }}
      className="w-full aspect-video object-cover bg-black cursor-pointer"
    />
  );
}

function LoopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8a5 5 0 0 1 5-5h4" />
      <path d="M9 1 11 3 9 5" />
      <path d="M14 8a5 5 0 0 1-5 5H5" />
      <path d="M7 15 5 13 7 11" />
    </svg>
  );
}

function Toggle({
  on, onChange, disabled, label,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors
                  disabled:opacity-50 disabled:cursor-not-allowed
                  ${on ? 'bg-emerald-500' : 'bg-zinc-700'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow
                    transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}
