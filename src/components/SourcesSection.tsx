'use client';

import { trpc } from '@/lib/trpc-client';

interface Props {
  activeSourceSlug: string | null;
  /** Open the in-sidebar sources manager (slides over the sidebar). */
  onOpenManager: () => void;
}

/**
 * Sidebar "Sources" entry — the EXTERNAL half of the libraries-vs-sources
 * division. A compact button showing the active external source; clicking it
 * slides the SourcesManager panel over the sidebar (add / reorder / rename /
 * delete). The panel itself lives at the sidebar level so it can slide as a
 * second layer rather than float on top of the page.
 */
export function SourcesSection({ activeSourceSlug, onOpenManager }: Props) {
  const sources = trpc.externalSource.list.useQuery();
  const list = sources.data ?? [];
  const active = list.find((s) => s.slug === activeSourceSlug) ?? null;

  return (
    <section className="mb-5">
      <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 px-3 mb-1.5">Sources</h3>

      <div className="px-1">
        <button
          onClick={onOpenManager}
          title="Manage external sources"
          className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition border
                      ${active
                        ? 'bg-zinc-800/80 text-zinc-100 border-zinc-700'
                        : 'bg-zinc-900/60 text-zinc-300 border-zinc-800 hover:border-zinc-700'}`}
        >
          <YouTubeMark />
          <span className="flex-1 truncate text-left">{active ? active.name : 'External sources'}</span>
          {list.length > 0 && (
            <span className="text-[10px] text-zinc-500 shrink-0 tabular-nums">{list.length}</span>
          )}
          <PanelIcon />
        </button>
      </div>
    </section>
  );
}

/** Signals "opens a side panel" (vs. the old dropdown chevron). */
function PanelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" className="text-zinc-500 shrink-0" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 4v16" stroke="currentColor" strokeWidth="1.6" />
    </svg>
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
