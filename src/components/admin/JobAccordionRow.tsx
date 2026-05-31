'use client';

/**
 * Accordion-style job row. Collapsed: compact one-line summary like
 * the old JobRow. Expanded: same summary + inline ProgressCard +
 * scrollable output log.
 *
 * The OutputPanel (which opens an SSE connection) only mounts when
 * expanded. Collapsing closes the EventSource — no zombie connections
 * for jobs the user isn't actively watching.
 */

import { useState } from 'react';
import type { AdminJobRow } from '@/server/admin/job-store';
import { OutputPanel } from './OutputPanel';

const STATUS_STYLE: Record<AdminJobRow['status'], string> = {
  queued:    'bg-zinc-700/40 text-zinc-300 ring-zinc-600/40',
  running:   'bg-emerald-900/40 text-emerald-200 ring-emerald-700/40 animate-pulse',
  completed: 'bg-zinc-800 text-zinc-300 ring-zinc-700',
  failed:    'bg-red-950/60 text-red-300 ring-red-900/60',
  canceled:  'bg-amber-950/40 text-amber-300 ring-amber-900/40',
};

export function JobAccordionRow({
  job,
  expanded,
  onToggle,
  onCancel,
}: {
  job: AdminJobRow;
  expanded: boolean;
  onToggle: () => void;
  onCancel?: () => void;
}) {
  const ts = (n: number | null) =>
    n ? new Date(n).toLocaleString(undefined, { hour12: false }) : '—';

  const canCancel = job.status === 'queued' || job.status === 'running';

  return (
    <div className={`rounded ring-1 transition
                     ${expanded
                       ? 'bg-zinc-900 ring-zinc-700'
                       : 'bg-zinc-900/40 ring-transparent hover:ring-zinc-800 hover:bg-zinc-900'}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2 text-left"
      >
        <Chevron expanded={expanded} />
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded
                          ring-1 ${STATUS_STYLE[job.status]}`}>
          {job.status}
        </span>
        <span className="font-mono text-xs text-zinc-300 min-w-[120px]">{job.command}</span>
        <span className="text-xs text-zinc-500 min-w-[80px]">
          {job.librarySlug ?? '—'}
        </span>
        <span className="text-xs text-zinc-600 flex-1 truncate">
          {Object.entries(job.args)
            .filter(([k]) => k !== 'library')
            .map(([k, v]) => `${k}=${v}`)
            .join(' · ') || ' '}
        </span>
        <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
          {ts(job.startedAt ?? job.enqueuedAt)}
        </span>
        {canCancel && onCancel && (
          <span
            // Use a div role=button so this nested click target doesn't
            // conflict with the outer <button> (button-in-button is invalid).
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }}
            className="text-[10px] text-zinc-500 hover:text-red-300 px-2 py-0.5
                       rounded hover:bg-red-950/40 transition cursor-pointer"
          >
            cancel
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          <OutputPanel jobId={job.id} onClose={onToggle} />
        </div>
      )}
    </div>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 10 10"
      className={`text-zinc-600 transition-transform shrink-0
                  ${expanded ? 'rotate-90' : ''}`}
    >
      <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
