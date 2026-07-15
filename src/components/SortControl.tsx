'use client';

import { useEffect, useRef, useState } from 'react';
import type { SortKey } from '@/lib/url-state';

/**
 * Sort dropdown for the left sidebar (lives with the facets). Shuffle used to
 * ride alongside it, but it now sits next to Play — a sort and a shuffle are
 * mutually exclusive orderings, and shuffle belongs with the "start playing"
 * action. In search / similar (`relevanceMode`), the default — `sort = null` —
 * is relevance, so a "Relevance" option leads the menu; in browse the default
 * is Newest.
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
  relevanceMode: boolean;
  /** null = the view's default (relevance in search, newest in browse). */
  onSelectSort: (key: SortKey | null) => void;
  /** Shuffle is active, so sorting is overridden — grey it out. */
  disabled?: boolean;
}

export function SortControl({ sort, relevanceMode, onSelectSort, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const buttonLabel = disabled
    ? 'Shuffled'
    : sort != null ? LABEL[sort] : relevanceMode ? 'Relevance' : 'Newest';
  const selectedKey: SortKey | 'relevance' =
    sort != null ? sort : relevanceMode ? 'relevance' : 'taken-desc';

  return (
    <div className="relative px-3" ref={ref}>
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={disabled ? 'Turn off shuffle to sort' : undefined}
        className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 text-sm ring-1 rounded-md transition
          ${disabled
            ? 'text-zinc-600 ring-zinc-800 cursor-not-allowed'
            : 'text-zinc-200 ring-zinc-700 hover:bg-zinc-900'}`}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <SortIcon />
          <span className="truncate">{buttonLabel}</span>
        </span>
        <ChevronIcon />
      </button>
      {open && !disabled && (
        <div className="absolute left-3 right-3 top-full mt-1.5 z-30 bg-zinc-900 ring-1 ring-zinc-800 rounded-lg shadow-xl py-1">
          {relevanceMode && (
            <SortMenuItem
              label="Relevance"
              selected={selectedKey === 'relevance'}
              onClick={() => { onSelectSort(null); setOpen(false); }}
            />
          )}
          {SORT_OPTIONS.map((o) => (
            <SortMenuItem
              key={o.key}
              label={o.label}
              selected={selectedKey === o.key}
              onClick={() => { onSelectSort(o.key); setOpen(false); }}
            />
          ))}
        </div>
      )}
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
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
      <path d="M3 4h10M3 8h7M3 12h4" />
    </svg>
  );
}
function ChevronIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500 shrink-0">
      <path d="M4 6l4 4 4-4" />
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
