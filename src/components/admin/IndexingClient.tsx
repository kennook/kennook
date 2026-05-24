'use client';

/**
 * Top-level client component for /admin/indexing. Composes:
 *   • catalog (top): grid of cards, click → opens RunDialog
 *   • queue (middle): currently-running + queued jobs
 *   • history (bottom): recent finished jobs
 *   • RunDialog: form for the selected job's options
 *   • OutputPanel: live SSE tail when a job is selected
 *
 * State:
 *   catalog       — fetched once
 *   jobs          — polled every 2s
 *   workspaces    — fetched via tRPC (re-use of existing query)
 *   selectedJobId — which job's output to show in the panel
 *   dialogJobId   — which job's RunDialog is open (null = closed)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import type { JobDefinition } from '@/server/admin/job-catalog';
import type { AdminJobRow } from '@/server/admin/job-store';
import { RunDialog } from './RunDialog';
import { JobAccordionRow } from './JobAccordionRow';

export function IndexingClient() {
  const [catalog, setCatalog] = useState<JobDefinition[] | null>(null);
  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  // Which job's accordion is expanded. Single-expand for focus —
  // expanding one collapses the previously-expanded one.
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  // Track which job ids we've already auto-expanded so a new run
  // expands automatically (nice UX) without yanking back open a
  // job the user explicitly collapsed.
  const autoExpandedRef = useRef<Set<number>>(new Set());
  const [dialogJobId, setDialogJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaces = trpc.workspace.list.useQuery();
  const workspaceSlugs = useMemo(
    () => (workspaces.data ?? []).map((w) => ({ slug: w.slug, name: w.name })),
    [workspaces.data],
  );

  // Catalog: load once.
  useEffect(() => {
    fetch('/api/admin/jobs/catalog')
      .then((r) => r.json())
      .then((data: { catalog: JobDefinition[] }) => setCatalog(data.catalog))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Jobs: poll every 2s. Cheap (single DB query) and covers both
  // new enqueues from this tab and ones from other admin tabs.
  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/jobs', { cache: 'no-store' });
      if (!res.ok) throw new Error(`/api/admin/jobs ${res.status}`);
      const data = await res.json() as { jobs: AdminJobRow[] };
      setJobs(data.jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refreshJobs();
    const t = setInterval(refreshJobs, 2000);
    // Refresh immediately on focus/visibility — covers the case where
    // the user came back to a background tab and the 2s interval was
    // throttled by the browser, or where they reload from another tab
    // and expect their changes reflected right away.
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

  // Auto-expand the most recently-started running job — but only if
  // we haven't auto-expanded it before AND the user isn't currently
  // viewing a different one. Keeps the "I just enqueued, show me
  // what's happening" UX without yanking the user out of inspecting
  // a different row.
  useEffect(() => {
    if (expandedJobId !== null) return;
    const running = jobs.find((j) => j.status === 'running');
    if (running && !autoExpandedRef.current.has(running.id)) {
      autoExpandedRef.current.add(running.id);
      setExpandedJobId(running.id);
    }
  }, [jobs, expandedJobId]);

  const handleEnqueue = useCallback(async (
    command: string,
    args: Record<string, string | number | boolean>,
  ) => {
    setError(null);
    const res = await fetch('/api/admin/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, args }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      setError(txt || `Enqueue failed (${res.status})`);
      return;
    }
    const data = await res.json() as { job: AdminJobRow };
    // Expand the new job so the user can immediately see its output.
    setExpandedJobId(data.job.id);
    autoExpandedRef.current.add(data.job.id);
    setDialogJobId(null);
    void refreshJobs();
  }, [refreshJobs]);

  const handleCancel = useCallback(async (jobId: number) => {
    const res = await fetch(`/api/admin/jobs/${jobId}/cancel`, { method: 'POST' });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      setError(txt || `Cancel failed (${res.status})`);
    }
    void refreshJobs();
  }, [refreshJobs]);

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const history = jobs.filter((j) =>
    j.status === 'completed' || j.status === 'failed' || j.status === 'canceled'
  ).slice(0, 30);

  const dialogJob = dialogJobId
    ? catalog?.find((c) => c.id === dialogJobId) ?? null
    : null;

  return (
    <div className="space-y-8">
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

      {/* ── Catalog ─────────────────────────────────────────────── */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Catalog</h2>
        {!catalog ? (
          <div className="text-sm text-zinc-500">Loading…</div>
        ) : (
          <CatalogGrid catalog={catalog} onPick={setDialogJobId} />
        )}
      </section>

      {/* ── Active + queued (expandable rows) ─────────────────── */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
          Active / Queued ({active.length})
        </h2>
        {active.length === 0 ? (
          <div className="text-sm text-zinc-600">Nothing running. Queue is empty.</div>
        ) : (
          <div className="space-y-1">
            {active.map((j) => (
              <JobAccordionRow
                key={j.id}
                job={j}
                expanded={expandedJobId === j.id}
                onToggle={() => setExpandedJobId(
                  expandedJobId === j.id ? null : j.id,
                )}
                onCancel={() => handleCancel(j.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Recent (expandable rows — same component) ─────────── */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
          Recent ({history.length})
        </h2>
        {history.length === 0 ? (
          <div className="text-sm text-zinc-600">No history yet.</div>
        ) : (
          <div className="space-y-1">
            {history.map((j) => (
              <JobAccordionRow
                key={j.id}
                job={j}
                expanded={expandedJobId === j.id}
                onToggle={() => setExpandedJobId(
                  expandedJobId === j.id ? null : j.id,
                )}
              />
            ))}
          </div>
        )}
      </section>

      {dialogJob && (
        <RunDialog
          definition={dialogJob}
          workspaces={workspaceSlugs}
          onCancel={() => setDialogJobId(null)}
          onSubmit={(args) => handleEnqueue(dialogJob.id, args)}
        />
      )}
    </div>
  );
}

function CatalogGrid({
  catalog,
  onPick,
}: {
  catalog: JobDefinition[];
  onPick: (id: string) => void;
}) {
  // Group by category for visual organisation.
  const groups: Record<string, JobDefinition[]> = {};
  for (const def of catalog) {
    (groups[def.category] ||= []).push(def);
  }
  const CATEGORY_LABELS: Record<string, string> = {
    index: 'Index',
    backfill: 'Backfill',
    enrich: 'Enrich',
    aggregate: 'Aggregate',
  };
  const order = ['index', 'backfill', 'enrich', 'aggregate'];

  return (
    <div className="space-y-5">
      {order.filter((c) => groups[c]).map((cat) => (
        <div key={cat}>
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-2 pl-1">
            {CATEGORY_LABELS[cat]}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {groups[cat].map((def) => (
              <button
                key={def.id}
                onClick={() => onPick(def.id)}
                className="text-left bg-zinc-900/60 hover:bg-zinc-800/80
                           ring-1 ring-zinc-800 hover:ring-zinc-700 rounded-lg
                           px-4 py-3 transition group"
              >
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="text-sm font-medium text-zinc-100">{def.label}</span>
                  <span className="font-mono text-[10px] text-zinc-600 group-hover:text-zinc-500">
                    {def.id}
                  </span>
                </div>
                <div className="text-xs text-zinc-400 leading-relaxed">
                  {def.description}
                </div>
                {def.longRunning && (
                  <div className="text-[10px] text-amber-400/80 mt-1.5">
                    ⏱ long-running
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
