'use client';

/**
 * Admin control for custom screensaver clips (mounted on /admin/settings). Drop
 * or choose videos; each POSTs to /api/admin/screensaver/upload, which stores it
 * and transcodes it to web-safe MP4 in the background. The list polls for the
 * processing → ready/failed flip. When any clip is `ready` it replaces the
 * built-in stock footage in the screensaver rotation across every screen.
 */

import { useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

/** 720p variant URL for a ready clip — small enough to preview inline. */
function previewUrl(id: string): string {
  return `/api/screensaver/media/${id}/720`;
}

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
    // Poll while anything is still transcoding so `processing` clears on its own.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c) => c.status === 'processing') ? 2000 : false,
  });
  const clips = list.data ?? [];

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

  async function uploadFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const key = `p${counter++}`;
      setPending((p) => [{ key, name: file.name, status: 'uploading' }, ...p]);

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
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-md mt-6">
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
        <div className="text-sm text-zinc-300">Drop a video here, or click to choose</div>
        <div className="text-[11px] text-zinc-500 mt-1">Converted in the background — up to 1 GB per file.</div>
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
        <ul className="mt-4 space-y-1">
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

          {clips.map((c) => {
            const isReady = c.status === 'ready';
            const on = c.enabled !== false;
            return (
              <li
                key={c.id}
                className="flex items-center gap-3 text-xs px-3 py-2 rounded
                           bg-zinc-900/50 ring-1 ring-zinc-800"
              >
                <ClipPreview id={c.id} ready={isReady} />
                <div className="min-w-0 flex-1">
                  <div className="text-zinc-200 truncate">{c.name}</div>
                  <div className="mt-0.5">
                    {c.status === 'processing' && <span className="text-amber-300">converting…</span>}
                    {isReady && (
                      <span className={on ? 'text-emerald-300' : 'text-zinc-500'}>
                        {on ? 'in rotation' : 'disabled'}
                      </span>
                    )}
                    {c.status === 'failed' && <span className="text-red-300" title={c.error}>failed</span>}
                  </div>
                </div>
                {isReady && (
                  <Toggle
                    on={on}
                    disabled={setEnabled.isPending}
                    label={`${c.name} in rotation`}
                    onChange={(v) => setEnabled.mutate({ id: c.id, enabled: v })}
                  />
                )}
                <button
                  onClick={() => remove.mutate({ id: c.id })}
                  disabled={remove.isPending}
                  title="Delete clip"
                  aria-label="Delete clip"
                  className="text-zinc-600 hover:text-red-300 transition disabled:opacity-40 shrink-0"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Small inline preview. Ready clips play the 720p variant on hover (muted,
 *  looping); non-ready ones show a placeholder. Tap also toggles play (touch). */
function ClipPreview({ id, ready }: { id: string; ready: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  if (!ready) return <div className="w-24 h-14 rounded bg-zinc-800 shrink-0" />;
  return (
    <video
      ref={ref}
      src={previewUrl(id)}
      muted
      loop
      playsInline
      preload="metadata"
      title="Hover to preview"
      onMouseEnter={() => { void ref.current?.play().catch(() => {}); }}
      onMouseLeave={() => { const v = ref.current; if (v) { v.pause(); v.currentTime = 0; } }}
      onClick={() => {
        const v = ref.current;
        if (!v) return;
        if (v.paused) void v.play().catch(() => {}); else v.pause();
      }}
      className="w-24 h-14 rounded object-cover bg-black shrink-0 cursor-pointer"
    />
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
