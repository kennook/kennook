'use client';

import { useEffect, useRef, useState } from 'react';
import type { SortKey } from '@/lib/url-state';

/**
 * Sort dropdown + Shuffle toggle for the results toolbar.
 *
 * Sort and shuffle are mutually exclusive orderings: picking a sort clears
 * shuffle (the parent handles that), and the highlighted Shuffle button means
 * the seeded-random order is active regardless of the sort shown. In search /
 * similar (`relevanceMode`), the default — `sort = null` — is relevance, so a
 * "Relevance" option leads the menu; in browse the default is Newest.
 */

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'taken-desc', label: 'Newest' },
  { key: 'taken-asc', label: 'Oldest' },
  { key: 'added-desc', label: 'Recently added' },
  { key: 'added-asc', label: 'Oldest added' },
  { key: 'likes', label: 'Most liked (you)' },
  { key: 'likes-all', label: 'Most liked (everyone)' },
  { key: 'views', label: 'Most viewed' },
];
const LABEL = Object.fromEntries(SORT_OPTIONS.map((o) => [o.key, o.label])) as Record<SortKey, string>;

interface Props {
  sort: SortKey | null;
  shuffle: number | null;
  relevanceMode: boolean;
  /** null = the view's default (relevance in search, newest in browse). */
  onSelectSort: (key: SortKey | null) => void;
  onToggleShuffle: () => void;
}

export function SortControl({ sort, shuffle, relevanceMode, onSelectSort, onToggleShuffle }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const shuffleActive = shuffle != null;
  const buttonLabel = sort != null ? LABEL[sort] : relevanceMode ? 'Relevance' : 'Newest';
  // What the menu marks as current (ignored visually while shuffling).
  const selectedKey: SortKey | 'relevance' =
    sort != null ? sort : relevanceMode ? 'relevance' : 'taken-desc';

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-zinc-300 ring-1 ring-zinc-800 rounded hover:bg-zinc-900 transition"
        >
          <SortIcon />
          <span>{buttonLabel}</span>
          <ChevronIcon />
        </button>
        {open && (
          <div className="absolute left-0 top-full mt-1.5 w-52 z-30 bg-zinc-900 ring-1 ring-zinc-800 rounded-lg shadow-xl py-1">
            {relevanceMode && (
              <SortMenuItem
                label="Relevance"
                selected={!shuffleActive && selectedKey === 'relevance'}
                onClick={() => { onSelectSort(null); setOpen(false); }}
              />
            )}
            {SORT_OPTIONS.map((o) => (
              <SortMenuItem
                key={o.key}
                label={o.label}
                selected={!shuffleActive && selectedKey === o.key}
                onClick={() => { onSelectSort(o.key); setOpen(false); }}
              />
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onToggleShuffle}
        title={shuffleActive ? 'Shuffle on — click to turn off' : 'Shuffle'}
        aria-pressed={shuffleActive}
        className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded ring-1 transition
          ${shuffleActive
            ? 'bg-emerald-600/90 text-white ring-emerald-500'
            : 'text-zinc-300 ring-zinc-800 hover:bg-zinc-900'}`}
      >
        <ShuffleIcon />
        <span>Shuffle</span>
      </button>
    </div>
  );
}

function SortMenuItem({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm text-left transition
        ${selected ? 'text-emerald-300' : 'text-zinc-300 hover:bg-zinc-800'}`}
    >
      <span>{label}</span>
      {selected && <CheckIcon />}
    </button>
  );
}

function SortIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 4h10M3 8h7M3 12h4" />
    </svg>
  );
}
function ChevronIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
function ShuffleIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4h2.5l7 8H14M2 12h2.5l3-3.4M11 9l3 3-3 3M11 1l3 3-3 3" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8l3.5 3.5L13 4" />
    </svg>
  );
}
