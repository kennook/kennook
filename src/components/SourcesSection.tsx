'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

interface Props {
  activeSourceSlug: string | null;
  onSelectSource: (slug: string | null) => void;
}

/**
 * Sidebar "Sources" picker — the EXTERNAL half of the libraries-vs-sources
 * division. A compact dropdown of external (YouTube) sources plus an "Add"
 * action. Selecting one switches the page into external mode.
 */
export function SourcesSection({ activeSourceSlug, onSelectSource }: Props) {
  const sources = trpc.externalSource.list.useQuery();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const remove = trpc.externalSource.remove.useMutation({
    onSuccess: (_d, vars) => {
      void utils.externalSource.list.invalidate();
      if (vars.slug === activeSourceSlug) onSelectSource(null);
    },
  });

  const list = sources.data ?? [];
  const active = list.find((s) => s.slug === activeSourceSlug) ?? null;
  const pick = (slug: string | null) => { onSelectSource(slug); setOpen(false); };

  return (
    <section className="mb-5">
      <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 px-3 mb-1.5">Sources</h3>

      <div className="relative px-1" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition border
                      ${active
                        ? 'bg-zinc-800/80 text-zinc-100 border-zinc-700'
                        : 'bg-zinc-900/60 text-zinc-300 border-zinc-800 hover:border-zinc-700'}`}
        >
          <YouTubeMark />
          <span className="flex-1 truncate text-left">{active ? active.name : 'External sources'}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-500 shrink-0">
            <path d="M1 3 L5 7 L9 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>

        {open && (
          <div className="absolute left-1 right-1 top-full mt-1 z-20 max-h-80 overflow-y-auto
                          bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1">
            <button
              onClick={() => pick(null)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-800 ${active ? 'text-zinc-400' : 'text-zinc-100'}`}
            >
              Back to library
            </button>
            {list.length > 0 && <div className="border-t border-zinc-800 my-1" />}
            {list.map((s) => {
              const isCurrent = s.slug === activeSourceSlug;
              return (
                <div key={s.slug} className="group flex items-center hover:bg-zinc-800">
                  <button
                    onClick={() => pick(isCurrent ? null : s.slug)}
                    className={`flex-1 min-w-0 text-left px-3 py-2 text-sm flex items-center gap-2
                                ${isCurrent ? 'text-zinc-100' : 'text-zinc-300'}`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-red-500/80" />
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className="text-[10px] uppercase text-zinc-600 shrink-0">{s.kind}</span>
                  </button>
                  <button
                    onClick={() => remove.mutate({ slug: s.slug })}
                    title="Remove source"
                    className="px-2 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <div className="border-t border-zinc-800 my-1" />
            <button
              onClick={() => { setOpen(false); setAdding(true); }}
              className="w-full text-left px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              + Add YouTube source…
            </button>
          </div>
        )}
      </div>

      {adding && (
        <AddSourceDialog
          onClose={() => setAdding(false)}
          onAdded={(slug) => { setAdding(false); onSelectSource(slug); }}
        />
      )}
    </section>
  );
}

function AddSourceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (slug: string) => void }) {
  const utils = trpc.useUtils();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = trpc.externalSource.create.useMutation({
    onSuccess: (src) => { void utils.externalSource.list.invalidate(); onAdded(src.slug); },
    onError: (e) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-6"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); if (url.trim()) create.mutate({ url: url.trim() }); }}
        className="w-full max-w-md bg-zinc-900 ring-1 ring-zinc-800 rounded-xl p-5 flex flex-col gap-3 shadow-2xl"
      >
        <h2 className="text-base font-medium text-zinc-100">Add a YouTube source</h2>
        <p className="text-xs text-zinc-500">
          Paste a channel or playlist URL — e.g.{' '}
          <span className="text-zinc-400">youtube.com/@channel</span> or{' '}
          <span className="text-zinc-400">youtube.com/playlist?list=…</span>
        </p>
        <input
          autoFocus
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          placeholder="https://www.youtube.com/@…"
          className="bg-zinc-950 border border-zinc-700 rounded-md px-3 py-2 text-sm outline-none focus:border-zinc-500"
        />
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            type="submit"
            disabled={create.isPending || !url.trim()}
            className="px-3 py-1.5 text-sm rounded-md bg-zinc-200 text-zinc-900 font-medium hover:bg-white disabled:opacity-40"
          >
            {create.isPending ? 'Adding…' : 'Add source'}
          </button>
        </div>
      </form>
    </div>
  );
}

function YouTubeMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" className="shrink-0 text-red-500" aria-hidden>
      <path fill="currentColor" d="M23 12s0-3.8-.5-5.6a2.9 2.9 0 0 0-2-2C18.7 4 12 4 12 4s-6.7 0-8.5.4a2.9 2.9 0 0 0-2 2C1 8.2 1 12 1 12s0 3.8.5 5.6a2.9 2.9 0 0 0 2 2C5.3 20 12 20 12 20s6.7 0 8.5-.4a2.9 2.9 0 0 0 2-2C23 15.8 23 12 23 12z" />
      <path fill="#fff" d="M10 15.5v-7l6 3.5z" />
    </svg>
  );
}
