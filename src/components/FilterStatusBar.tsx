'use client';

export interface ActiveFilter {
  key: string;
  label: string;
  onRemove: () => void;
}

interface Props {
  filters: ActiveFilter[];
  onClearAll: () => void;
}

/**
 * Sticky-feeling status strip above the grid that lists every filter
 * currently narrowing the results. Each chip × removes just that filter;
 * "Clear all" nukes the lot in one click.
 *
 * Renders nothing when no filters are active, so it never adds vertical
 * noise on the default view.
 *
 * Deliberately excludes the "view mode" axes (search query, playlist,
 * similar-to-source) — those already have their own loud headers and
 * clearing them mid-flow is a different action than "remove a filter".
 */
export function FilterStatusBar({ filters, onClearAll }: Props) {
  if (filters.length === 0) return null;
  return (
    <div className="mb-4 flex items-center gap-2 flex-wrap
                    bg-amber-950/30 border border-amber-900/40 rounded-lg
                    px-3 py-2 text-sm">
      <span className="text-[10px] uppercase tracking-wider text-amber-300/80 shrink-0">
        Filtered
      </span>
      {filters.map((f) => (
        <button
          key={f.key}
          onClick={f.onRemove}
          className="inline-flex items-center gap-1 bg-zinc-900 hover:bg-zinc-800
                     text-zinc-200 rounded-full px-2.5 py-0.5 text-xs transition"
          title={`Remove “${f.label}” filter`}
        >
          <span className="truncate max-w-[16ch]">{f.label}</span>
          <span className="text-zinc-500" aria-hidden>×</span>
        </button>
      ))}
      <div className="flex-1" />
      <button
        onClick={onClearAll}
        className="text-xs text-amber-300 hover:text-amber-200 px-2 py-0.5 transition shrink-0"
      >
        Clear all
      </button>
    </div>
  );
}
