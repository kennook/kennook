'use client';

import { useState } from 'react';
import type { SortKey } from '@/lib/url-state';
import type {
  FacetCounts,
  Kind,
  Orientation,
  Quality,
  Watched,
} from '@/components/FilterSidebar';

/**
 * Mobile filter bottom-sheet. A curated, touch-first subset of the desktop
 * FilterSidebar — Sort, Type, Watched, Likes, Quality, Orientation, Tags,
 * Mentioned (person filtering lives in the People tab). Filters apply LIVE:
 * each tap writes one `url.set(patch)` via the `set` prop and the grid + facet
 * counts re-query. Options with a zero facet count that aren't selected are
 * hidden, matching the sidebar.
 *
 * Reuses the LikesSheet shell (backdrop, grab handle, safe-area inset), but the
 * body scrolls since there are many groups.
 */

export interface MobileFilterValues {
  sort: SortKey | null;
  kind: Kind | null;
  watched: Watched | null;
  minLikes: number | null;
  quality: Quality | null;
  orientation: Orientation | null;
  tags: string[];
  mentioned: string[];
}

interface Props {
  facets: FacetCounts | null;
  /** Search / similar mode — relevance is the default sort, so lead with it. */
  relevanceMode: boolean;
  values: MobileFilterValues;
  /** Number of active filters (sort excluded) — drives the "Clear all" button. */
  activeCount: number;
  /** Single-shot URL write. Callers batch into ONE patch to avoid clobbering. */
  set: (patch: Partial<MobileFilterValues>) => void;
  onClose: () => void;
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'taken-desc', label: 'Newest' },
  { key: 'taken-asc', label: 'Oldest' },
  { key: 'added-desc', label: 'Recently added' },
  { key: 'added-asc', label: 'Oldest added' },
  { key: 'likes', label: 'Most liked (you)' },
  { key: 'likes-all', label: 'Most liked (everyone)' },
  { key: 'views', label: 'Most viewed' },
];

const ORIENTATION_LABELS: Record<Orientation, string> = {
  portrait: 'Portrait',
  landscape: 'Landscape',
  square: 'Square',
};

const QUALITY_ORDER: Quality[] = ['4k', 'hd', 'sd'];
const QUALITY_LABELS: Record<Quality, string> = { '4k': '4K+', hd: 'HD', sd: 'SD' };

interface LikesOption { label: string; value: number | null; hearts: number; }
const LIKES_OPTIONS: LikesOption[] = [
  { label: 'Any', value: null, hearts: 0 },
  { label: '1+ likes', value: 1, hearts: 1 },
  { label: '2+ likes', value: 2, hearts: 2 },
  { label: '3+ likes', value: 3, hearts: 3 },
  { label: '4+ likes', value: 4, hearts: 4 },
  { label: 'Top picks', value: 5, hearts: 5 },
];

export function MobileFilterSheet({
  facets, relevanceMode, values, activeCount, set, onClose,
}: Props) {
  const { sort, kind, watched, minLikes, quality, orientation, tags, mentioned } = values;

  const toggleTag = (t: string) =>
    set({ tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] });
  const toggleMentioned = (t: string) =>
    set({ mentioned: mentioned.includes(t) ? mentioned.filter((x) => x !== t) : [...mentioned, t] });

  // "Clear all" leaves sort alone (it's not a filter) and leaves person/query,
  // which are cleared from their own surfaces. One url.set → one history write.
  const clearAll = () =>
    set({ kind: null, watched: null, minLikes: null, quality: null, orientation: null, tags: [], mentioned: [] });

  // Sort's effective selection: an explicit sort wins; else relevance in search,
  // else Newest in browse.
  const selectedSort: SortKey | 'relevance' =
    sort != null ? sort : relevanceMode ? 'relevance' : 'taken-desc';

  return (
    <>
      <button onClick={onClose} aria-label="Close" className="fixed inset-0 z-40 bg-black/70" />
      <div
        className="fixed bottom-0 inset-x-0 z-50 flex flex-col max-h-[85vh]
                   bg-zinc-900 rounded-t-2xl border-t border-zinc-800
                   pb-[max(env(safe-area-inset-bottom),0.5rem)]"
      >
        <div className="flex justify-center py-2 shrink-0">
          <div className="w-9 h-1 rounded-full bg-zinc-700" />
        </div>
        <div className="flex items-center justify-between px-4 pb-2 shrink-0">
          <h3 className="text-base font-semibold text-zinc-100">Filters</h3>
          {activeCount > 0 && (
            <button onClick={clearAll} className="text-sm text-zinc-400 active:text-zinc-200 px-2 py-1">
              Clear all
            </button>
          )}
        </div>

        <div className="overflow-y-auto flex-1 pb-2">
          {/* Sort */}
          <Group title="Sort">
            {relevanceMode && (
              <Row active={selectedSort === 'relevance'} onClick={() => set({ sort: null })}>
                Relevance
              </Row>
            )}
            {SORT_OPTIONS.map((o) => (
              <Row key={o.key} active={selectedSort === o.key} onClick={() => set({ sort: o.key })}>
                {o.label}
              </Row>
            ))}
          </Group>

          {/* Type */}
          <Group title="Type">
            <Row active={kind === null} onClick={() => set({ kind: null })}>All</Row>
            {(['photo', 'video'] as const).map((k) => {
              const count = facets?.kinds.find((c) => c.value === k)?.count ?? 0;
              if (count === 0 && kind !== k) return null;
              return (
                <Row key={k} active={kind === k} count={count} onClick={() => set({ kind: k })}>
                  {k === 'photo' ? 'Photos' : 'Videos'}
                </Row>
              );
            })}
          </Group>

          {/* Watched */}
          <Group title="Watched">
            <div className="px-4">
              <div className="flex rounded-lg ring-1 ring-zinc-800 overflow-hidden">
                <Seg active={watched === null} onClick={() => set({ watched: null })} label="All" />
                <Seg active={watched === 'unwatched'} onClick={() => set({ watched: 'unwatched' })} label="Unwatched" tone="amber" />
                <Seg active={watched === 'watched'} onClick={() => set({ watched: 'watched' })} label="Watched" tone="emerald" />
              </div>
            </div>
          </Group>

          {/* Likes */}
          <Group title="Likes">
            {LIKES_OPTIONS.map((opt) => (
              <Row
                key={opt.label}
                active={opt.value === minLikes}
                onClick={() => set({ minLikes: opt.value })}
                trailing={
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Heart key={i} filled={i < opt.hearts} />
                    ))}
                  </span>
                }
              >
                {opt.label}
              </Row>
            ))}
          </Group>

          {/* Quality */}
          <Group title="Quality">
            <Row active={quality === null} onClick={() => set({ quality: null })}>All</Row>
            {QUALITY_ORDER.map((q) => {
              const count = facets?.qualities.find((c) => c.value === q)?.count ?? 0;
              if (count === 0 && quality !== q) return null;
              return (
                <Row key={q} active={quality === q} count={count} onClick={() => set({ quality: q })}>
                  {QUALITY_LABELS[q]}
                </Row>
              );
            })}
          </Group>

          {/* Orientation */}
          <Group title="Orientation">
            <Row active={orientation === null} onClick={() => set({ orientation: null })}>All</Row>
            {(['portrait', 'landscape', 'square'] as const).map((o) => {
              const count = facets?.orientations.find((c) => c.value === o)?.count ?? 0;
              if (count === 0 && orientation !== o) return null;
              return (
                <Row key={o} active={orientation === o} count={count} onClick={() => set({ orientation: o })}>
                  {ORIENTATION_LABELS[o]}
                </Row>
              );
            })}
          </Group>

          {/* Tags (seen) */}
          <TagGroup
            title="Tags"
            options={facets?.tags ?? []}
            selected={tags}
            onToggle={toggleTag}
          />

          {/* Mentioned (said) */}
          <TagGroup
            title="Mentioned"
            hint="Heard in the audio"
            accent="sky"
            options={facets?.mentioned ?? []}
            selected={mentioned}
            onToggle={toggleMentioned}
          />
        </div>
      </div>
    </>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 px-4 mb-1">
        {title}
        {hint && <span className="ml-1.5 normal-case tracking-normal text-zinc-600">· {hint}</span>}
      </h4>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Row({
  active, count, onClick, trailing, children,
}: {
  active: boolean;
  count?: number;
  onClick: () => void;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 text-[15px] text-left active:bg-zinc-800 transition
                  ${active ? 'text-emerald-400' : 'text-zinc-100'}`}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
      <span className="flex-1 truncate">{children}</span>
      {trailing ?? (typeof count === 'number' && count > 0 && (
        <span className="text-xs text-zinc-500 tabular-nums shrink-0">{count}</span>
      ))}
    </button>
  );
}

function TagGroup({
  title, hint, accent = 'emerald', options, selected, onToggle,
}: {
  title: string;
  hint?: string;
  accent?: 'emerald' | 'sky';
  options: Array<{ value: string; count: number }>;
  selected: string[];
  onToggle: (t: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const MAX_COLLAPSED = 8;

  if (options.length === 0 && selected.length === 0) return null;

  // Selected tags pinned first even if they've dropped out of the top-N.
  const selectedSet = new Set(selected);
  const rest = options.filter((o) => !selectedSet.has(o.value));
  const selectedAsOptions = selected.map((t) => ({
    value: t,
    count: options.find((o) => o.value === t)?.count ?? 0,
  }));
  const all = [...selectedAsOptions, ...rest];
  const visible = expanded ? all : all.slice(0, MAX_COLLAPSED);
  const remaining = all.length - visible.length;

  const checkedBox = accent === 'sky' ? 'bg-sky-400 border-sky-400' : 'bg-emerald-400 border-emerald-400';

  return (
    <Group title={title} hint={hint}>
      {visible.map(({ value, count }) => {
        const checked = selectedSet.has(value);
        return (
          <button
            key={value}
            onClick={() => onToggle(value)}
            className={`w-full flex items-center gap-3 px-4 py-3 text-[15px] text-left active:bg-zinc-800 transition
                        ${checked ? 'text-zinc-100' : 'text-zinc-300'}`}
          >
            <span
              className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center
                          ${checked ? checkedBox : 'border-zinc-600 bg-transparent'}`}
            >
              {checked && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="black" strokeWidth="2">
                  <path d="M2 5 L4 7 L8 3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <span className="flex-1 truncate">{value}</span>
            {count > 0 && <span className="text-xs text-zinc-500 tabular-nums shrink-0">{count}</span>}
          </button>
        );
      })}
      {remaining > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="text-sm text-zinc-500 active:text-zinc-300 px-4 py-2 text-left"
        >
          + {remaining} more
        </button>
      )}
    </Group>
  );
}

function Seg({
  active, onClick, label, tone = 'zinc',
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: 'zinc' | 'amber' | 'emerald';
}) {
  const activeBg =
    tone === 'amber' ? 'bg-amber-600 text-amber-50'
    : tone === 'emerald' ? 'bg-emerald-600 text-emerald-50'
    : 'bg-zinc-700 text-zinc-100';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 min-w-0 px-2 py-2.5 text-[13px] leading-none transition
                  border-r border-zinc-800 last:border-r-0
                  ${active ? activeBg : 'text-zinc-400 active:bg-zinc-800'}`}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16"
      fill={filled ? '#f43f5e' : 'transparent'}
      stroke={filled ? '#f43f5e' : 'rgba(255,255,255,0.25)'}
      strokeWidth="1.4" strokeLinejoin="round"
    >
      <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
    </svg>
  );
}
