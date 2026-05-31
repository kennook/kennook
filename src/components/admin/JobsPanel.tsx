'use client';

/**
 * Active + queued + recent admin jobs, with per-row accordion that streams
 * the live SSE output. Drop this anywhere you want job progress visible.
 *
 * State management mirrors the (now-retired) IndexingClient: poll every 2s,
 * auto-expand the most recent running job exactly once (so newly-enqueued
 * jobs surface their output without us yanking the user off another row).
 *
 * Cancellation hits /api/admin/jobs/<id>/cancel; running jobs that get
 * canceled fall through to the 'canceled' history bucket on the next poll.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminJobRow } from '@/server/admin/job-store';
import { JobAccordionRow } from './JobAccordionRow';

export function JobsPanel() {
  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  // Tracks which job ids we've already auto-expanded, so explicitly
  // collapsing one doesn't get yanked back open by a refetch.
  const autoExpandedRef = useRef<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/jobs', { cache: 'no-store' });
      if (!res.ok) throw new Error(`/api/admin/jobs ${res.status}`);
      const data = await res.json() as { jobs: AdminJobRow[]; paused?: boolean };
      setJobs(data.jobs);
      setPaused(!!data.paused);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const togglePause = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/jobs/${paused ? 'resume' : 'pause'}`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text().catch(() => `Failed (${res.status})`));
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [paused, refreshJobs]);

  useEffect(() => {
    void refreshJobs();
    const t = setInterval(refreshJobs, 2000);
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refreshJobs();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refreshJobs]);

  // Auto-expand:
  //   1. The most recently-started running job (so the user sees output
  //      flowing in for the thing they just kicked off).
  //   2. The most recently-failed job that hasn't been auto-expanded
  //      before. Crashes that never reach 'running' (instant spawn
  //      failures, exit-1 within milliseconds) would otherwise vanish
  //      into a collapsed history row with no surfaced error.
  // Only one job auto-expands per session per id — explicit collapses stick.
  useEffect(() => {
    if (expandedJobId !== null) return;
    const running = jobs.find((j) => j.status === 'running');
    if (running && !autoExpandedRef.current.has(running.id)) {
      autoExpandedRef.current.add(running.id);
      setExpandedJobId(running.id);
      return;
    }
    const recentFailed = jobs.find((j) => j.status === 'failed');
    if (recentFailed && !autoExpandedRef.current.has(recentFailed.id)) {
      autoExpandedRef.current.add(recentFailed.id);
      setExpandedJobId(recentFailed.id);
    }
  }, [jobs, expandedJobId]);

  const handleCancel = useCallback(async (jobId: number) => {
    const res = await fetch(`/api/admin/jobs/${jobId}/cancel`, { method: 'POST' });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      setError(txt || `Cancel failed (${res.status})`);
    }
    void refreshJobs();
  }, [refreshJobs]);

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const history = jobs
    .filter((j) => j.status === 'completed' || j.status === 'failed' || j.status === 'canceled')
    .slice(0, 30);

  if (jobs.length === 0 && !error) {
    return null; // nothing to show — keep the page quiet
  }

  const hasWork = active.length > 0;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md bg-red-950/40 border border-red-900 text-red-200
                        px-3 py-2 text-sm">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 text-red-400 hover:text-red-200"
          >dismiss</button>
        </div>
      )}

      {/* Queue control bar — Pause/Resume + the reassurance the user
          specifically asked for. Always-visible while there's work so the
          "you can stop anytime, nothing is lost" message is impossible to miss. */}
      {(hasWork || paused) && (
        <div className={`flex items-center justify-between gap-3 rounded-lg px-4 py-3 ring-1
                         ${paused
                           ? 'bg-amber-950/30 ring-amber-900/50'
                           : 'bg-zinc-900/60 ring-zinc-800'}`}>
          <div className="text-sm">
            {paused ? (
              <span className="text-amber-200">
                <span className="font-medium">Paused.</span> The queue is holding —
                resume whenever you&apos;re ready.
              </span>
            ) : (
              <span className="text-zinc-300">
                <span className="font-medium text-zinc-100">Processing your library.</span>{' '}
                <span className="text-zinc-400">
                  Pause or stop anytime — finished items are saved automatically and
                  nothing restarts from scratch.
                </span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={togglePause}
            disabled={busy}
            className={`shrink-0 px-3 py-1.5 text-sm rounded transition disabled:opacity-50
                        ${paused
                          ? 'bg-emerald-700 hover:bg-emerald-600 text-emerald-50'
                          : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 ring-1 ring-zinc-700'}`}
          >
            {busy ? '…' : paused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      )}

      {active.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
            Active / Queued ({active.length})
          </h2>
          <div className="space-y-1">
            {active.map((j) => (
              <JobAccordionRow
                key={j.id}
                job={j}
                expanded={expandedJobId === j.id}
                onToggle={() => setExpandedJobId(expandedJobId === j.id ? null : j.id)}
                onCancel={() => handleCancel(j.id)}
              />
            ))}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
            Recent ({history.length})
          </h2>
          <div className="space-y-1">
            {history.map((j) => (
              <JobAccordionRow
                key={j.id}
                job={j}
                expanded={expandedJobId === j.id}
                onToggle={() => setExpandedJobId(expandedJobId === j.id ? null : j.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
