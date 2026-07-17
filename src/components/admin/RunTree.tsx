'use client';

/**
 * Hierarchical run tree for one drive (AWS Step-Functions-style). Renders the
 * pipeline — Index → Backfill → Enrich — as a tree of nodes, each showing its
 * pending count + ETA and a LIVE status from this drive's jobs. "Run" on any
 * node enqueues that step (or the group's aggregate) scoped to this drive; the
 * server gates execution by dependency and runs one job at a time, so nodes
 * flip waiting → running → done in order.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminJobRow } from '@/server/admin/job-store';

interface Estimate {
  command: string;
  label: string;
  category: string;
  speed: 'fast' | 'medium' | 'slow' | 'very-slow' | null;
  pendingCount: number | null;
  etaSeconds: number | null;
}

interface Group { label: string; runCommand: string; steps: string[]; }

const GROUPS: Group[] = [
  { label: 'Index', runCommand: 'indexer', steps: ['indexer'] },
  { label: 'Backfill', runCommand: 'backfill:all', steps: ['backfill:vectors', 'backfill:previews', 'backfill:views'] },
  {
    label: 'Enrich', runCommand: 'enrich:all',
    steps: ['enrich:text', 'enrich:video-text', 'enrich:transcript', 'enrich:transcript-tags', 'enrich:scrub', 'enrich:faces', 'enrich:sensitive', 'enrich:people'],
  },
];
// Commands whose pipeline includes an indexer pass need the drive's root path.
const NEEDS_PATH = new Set(['indexer', 'setup']);

const SHORT: Record<string, string> = {
  'indexer': 'Index',
  'backfill:vectors': 'Vectors', 'backfill:previews': 'Previews', 'backfill:views': 'Views',
  'enrich:text': 'Text (VLM)', 'enrich:video-text': 'Video text (OCR)', 'enrich:transcript': 'Transcript',
  'enrich:transcript-tags': 'Transcript tags', 'enrich:scrub': 'Scrub previews',
  'enrich:faces': 'Faces', 'enrich:sensitive': 'Sensitive', 'enrich:people': 'People (cluster)',
};

function formatEta(sec: number | null): string | null {
  if (sec == null) return null;
  if (sec < 45) return '< 1 min';
  const min = Math.round(sec / 60);
  if (min < 90) return `~${min} min`;
  const hr = sec / 3600;
  return `~${hr.toFixed(hr < 10 ? 1 : 0)} hr`;
}

type Chip = { label: string; cls: string; pulse?: boolean };

export function RunTree({
  librarySlug, storageId, rootPath, onEnqueued, onError,
}: {
  librarySlug: string;
  storageId: number;
  rootPath: string;
  onEnqueued: (label: string, jobIds: number[]) => void;
  onError: (message: string) => void;
}) {
  const [estimates, setEstimates] = useState<Record<string, Estimate>>({});
  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const activeRef = useRef(false);

  const loadEstimates = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/estimate?lib=${encodeURIComponent(librarySlug)}&storage=${storageId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as { estimates: Estimate[] };
      setEstimates(Object.fromEntries(data.estimates.map((e) => [e.command, e])));
    } catch { /* best-effort */ }
  }, [librarySlug, storageId]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/jobs?storage=${storageId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as { jobs: AdminJobRow[] };
      setJobs(data.jobs);
      const active = data.jobs.some((j) => j.status === 'running' || j.status === 'queued');
      // Refresh pending counts when work has just wrapped up.
      if (activeRef.current && !active) void loadEstimates();
      activeRef.current = active;
    } catch { /* best-effort */ }
  }, [storageId, loadEstimates]);

  useEffect(() => {
    void loadEstimates();
    void loadJobs();
    const t = setInterval(loadJobs, 2000);
    return () => clearInterval(t);
  }, [loadEstimates, loadJobs]);

  // Latest job per command for THIS drive (jobs come newest-first).
  const latestFor = (command: string): AdminJobRow | null => jobs.find((j) => j.command === command) ?? null;
  const statusById = (id: number) => jobs.find((j) => j.id === id)?.status ?? null;

  const chipFor = (command: string): Chip | null => {
    const job = latestFor(command);
    if (!job) return null;
    switch (job.status) {
      case 'running': return { label: 'running', cls: 'text-emerald-300 bg-emerald-950/50 ring-emerald-800/60', pulse: true };
      case 'queued': {
        const waiting = job.dependsOn.some((d) => statusById(d) !== 'completed');
        return waiting
          ? { label: 'waiting', cls: 'text-amber-300 bg-amber-950/40 ring-amber-900/50' }
          : { label: 'queued', cls: 'text-zinc-300 bg-zinc-800/70 ring-zinc-700' };
      }
      case 'completed': return { label: 'done', cls: 'text-emerald-300 bg-emerald-950/30 ring-emerald-900/40' };
      case 'failed': return { label: 'failed', cls: 'text-red-300 bg-red-950/40 ring-red-900/50' };
      case 'canceled': return { label: 'skipped', cls: 'text-zinc-400 bg-zinc-900 ring-zinc-800' };
    }
  };

  const run = useCallback(async (command: string, label: string) => {
    setBusy(command);
    try {
      const args: Record<string, string> = { library: librarySlug, storage: String(storageId) };
      if (NEEDS_PATH.has(command)) args.path = rootPath;
      const res = await fetch('/api/admin/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, args, storageId }),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `Enqueue failed (${res.status})`));
      const data = await res.json() as { jobs: Array<{ id: number }> };
      onEnqueued(label, data.jobs.map((j) => j.id));
      void loadJobs();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [librarySlug, storageId, rootPath, onEnqueued, onError, loadJobs]);

  const RunBtn = ({ command, label, primary }: { command: string; label: string; primary?: boolean }) => (
    <button
      type="button"
      onClick={() => run(command, label)}
      disabled={busy !== null}
      className={`shrink-0 px-2 py-0.5 text-xs rounded transition disabled:opacity-40
        ${primary
          ? 'bg-emerald-700 hover:bg-emerald-600 text-emerald-50'
          : 'text-zinc-300 ring-1 ring-zinc-700 hover:bg-zinc-800'}`}
    >
      {busy === command ? '…' : 'Run'}
    </button>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500">Run pipeline</h3>
        <RunBtn command="setup" label="Setup — Full pipeline" primary />
      </div>

      <div className="space-y-1">
        {GROUPS.map((g) => {
          const isGroup = g.steps.length > 1;
          return (
            <div key={g.label} className="rounded-lg ring-1 ring-zinc-800 bg-zinc-950/40">
              {/* Group header */}
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-sm text-zinc-200 font-medium">{g.label}</span>
                {isGroup && <span className="text-[10px] text-zinc-600">({g.steps.length})</span>}
                {/* Single-step nodes (Index) surface their own status here. */}
                {!isGroup && (() => {
                  const chip = chipFor(g.steps[0]);
                  return chip ? (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ring-1 ${chip.cls} ${chip.pulse ? 'animate-pulse' : ''}`}>
                      {chip.label}
                    </span>
                  ) : null;
                })()}
                <div className="flex-1" />
                {!isGroup && (() => {
                  const eta = formatEta(estimates[g.steps[0]]?.etaSeconds ?? null);
                  const pending = estimates[g.steps[0]]?.pendingCount ?? null;
                  return (pending != null && pending > 0) || eta ? (
                    <span className="text-[11px] text-zinc-500 tabular-nums">
                      {pending != null && pending > 0 ? `${pending.toLocaleString()} pending` : ''}{eta ? ` · ${eta}` : ''}
                    </span>
                  ) : null;
                })()}
                <RunBtn command={g.runCommand} label={isGroup ? `${g.label} — All` : SHORT[g.runCommand] ?? g.runCommand} />
              </div>
              {/* Steps */}
              {isGroup && (
                <div className="border-t border-zinc-900 px-3 py-1.5 space-y-1">
                  {g.steps.map((s) => {
                    const est = estimates[s];
                    const chip = chipFor(s);
                    const eta = formatEta(est?.etaSeconds ?? null);
                    const pending = est?.pendingCount ?? null;
                    return (
                      <div key={s} className="flex items-center gap-2 pl-3 relative">
                        <span className="absolute left-0 top-1/2 w-2 border-t border-zinc-800" aria-hidden />
                        <span className="text-sm text-zinc-300">{SHORT[s] ?? s}</span>
                        {chip && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ring-1 ${chip.cls} ${chip.pulse ? 'animate-pulse' : ''}`}>
                            {chip.label}
                          </span>
                        )}
                        <div className="flex-1" />
                        <span className="text-[11px] text-zinc-500 tabular-nums">
                          {pending != null && pending > 0 ? `${pending.toLocaleString()} pending` : (chip?.label === 'done' ? '' : 'nothing pending')}
                          {eta ? ` · ${eta}` : ''}
                        </span>
                        <RunBtn command={s} label={SHORT[s] ?? s} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">
        Steps run one at a time; a step waits (and shows <span className="text-amber-300">waiting</span>) until its
        prerequisites finish. If a prerequisite fails, dependent steps are skipped.
      </p>
    </div>
  );
}
