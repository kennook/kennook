'use client';

/**
 * Per-storage "Run ▾" dropdown. Lists every runnable process — the common
 * aggregates up top, individual steps below — each with a rough time
 * estimate (or speed chip when an exact estimate isn't computable). Clicking
 * one POSTs to /api/admin/jobs; the server expands aggregates into discrete
 * queued jobs. Progress renders in the JobsPanel below the table.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

interface Props {
  librarySlug: string;
  rootPath: string;
  onEnqueued: (label: string, jobIds: number[]) => void;
  onError: (message: string) => void;
}

interface ActionEstimate {
  command: string;
  label: string;
  category: 'index' | 'backfill' | 'enrich' | 'aggregate';
  speed: 'fast' | 'medium' | 'slow' | 'very-slow' | null;
  pendingCount: number | null;
  etaSeconds: number | null;
}

// Commands whose pipeline includes an indexer pass need the storage root path.
const NEEDS_PATH = new Set(['indexer', 'setup']);

const SPEED_LABEL: Record<string, string> = {
  fast: 'fast', medium: 'medium', slow: 'slow', 'very-slow': 'very slow',
};
const SPEED_TONE: Record<string, string> = {
  fast: 'text-emerald-300',
  medium: 'text-zinc-400',
  slow: 'text-amber-300',
  'very-slow': 'text-orange-300',
};

function formatEta(sec: number | null): string | null {
  if (sec == null) return null;
  if (sec < 45) return '< 1 min';
  const min = Math.round(sec / 60);
  if (min < 90) return `~${min} min`;
  const hr = (sec / 3600);
  return `~${hr.toFixed(hr < 10 ? 1 : 0)} hr`;
}

export function RunStorageMenu({ librarySlug, rootPath, onEnqueued, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [estimates, setEstimates] = useState<ActionEstimate[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Fetch estimates each time the menu opens — pending counts shift as jobs
  // complete, so a fresh read keeps the numbers honest.
  const loadEstimates = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/estimate?lib=${encodeURIComponent(librarySlug)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as { estimates: ActionEstimate[] };
      setEstimates(data.estimates);
    } catch { /* estimates are best-effort; menu still works without them */ }
  }, [librarySlug]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void loadEstimates();
  };

  const enqueue = async (a: ActionEstimate) => {
    setOpen(false);
    setBusy(true);
    try {
      const args: Record<string, string> = { library: librarySlug };
      if (NEEDS_PATH.has(a.command)) args.path = rootPath;
      const res = await fetch('/api/admin/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: a.command, args }),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `Enqueue failed (${res.status})`));
      const data = await res.json() as { jobs: Array<{ id: number }> };
      onEnqueued(a.label, data.jobs.map((j) => j.id));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const aggregates = estimates?.filter((e) => e.category === 'aggregate' || e.command === 'indexer') ?? [];
  const steps = estimates?.filter((e) => e.category !== 'aggregate' && e.command !== 'indexer') ?? [];

  const renderItem = (a: ActionEstimate, isLast = false) => {
    const eta = formatEta(a.etaSeconds);
    const speedLabel = a.speed ? SPEED_LABEL[a.speed] : null;
    return (
      <button
        key={a.command}
        type="button"
        onClick={() => enqueue(a)}
        className={`block w-full text-left px-3 py-2 text-sm hover:bg-zinc-800 transition
                    ${isLast ? '' : ''}`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-zinc-100">{a.label}</span>
          <span className="shrink-0 text-[11px]">
            {eta ? (
              <span className="text-zinc-300">{eta}</span>
            ) : speedLabel ? (
              <span className={SPEED_TONE[a.speed!]}>{speedLabel}</span>
            ) : null}
          </span>
        </div>
        {a.pendingCount != null && a.pendingCount > 0 && (
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {a.pendingCount.toLocaleString()} pending
            {speedLabel && eta && <span className="text-zinc-600"> · {speedLabel}</span>}
          </div>
        )}
        {a.pendingCount === 0 && (
          <div className="text-[11px] text-zinc-600 mt-0.5">nothing pending</div>
        )}
      </button>
    );
  };

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        className="px-2.5 py-1 text-xs text-zinc-300 hover:text-zinc-100
                   ring-1 ring-zinc-800 hover:ring-zinc-700 rounded transition
                   disabled:opacity-50 disabled:cursor-not-allowed
                   inline-flex items-center gap-1"
      >
        {busy ? 'Enqueuing…' : 'Run'}
        <svg width="8" height="8" viewBox="0 0 10 10" className="text-zinc-500">
          <path d="M1 3 L5 7 L9 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-80 z-30 max-h-[70vh] overflow-y-auto
                        bg-zinc-900 ring-1 ring-zinc-800 rounded-lg shadow-xl py-1 whitespace-normal">
          {!estimates ? (
            <div className="px-3 py-3 text-xs text-zinc-500">Loading estimates…</div>
          ) : (
            <>
              <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
                Pipelines
              </div>
              {aggregates.map((a) => renderItem(a))}
              <div className="border-t border-zinc-800 my-1" />
              <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
                Individual steps
              </div>
              {steps.map((a) => renderItem(a))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
