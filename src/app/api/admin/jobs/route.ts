/**
 * GET  /api/admin/jobs        — list recent jobs (most recent first)
 * POST /api/admin/jobs        — enqueue a new job
 *
 * Both gated to admins by `requireAdmin`. POST body shape:
 *   { command: string, args: Record<string, string|number|boolean> }
 *
 * `library_slug` is extracted from args.library if present, so the
 * job catalog UI just submits a flat options object.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { getJobDefinition, expandCommand } from '@/server/admin/job-catalog';
import { enqueue, isPaused, ensureRunnerStarted } from '@/server/admin/job-runner';
import { listJobs, type AdminJobRow } from '@/server/admin/job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;
  // Boot the runner on page view, not just on enqueue/pause/resume. This is
  // what runs reapOrphanedRunningJobs() — without it, a job left 'running'
  // by a killed process stays 'running' forever if you only ever VIEW the
  // jobs page (the common case), and the queue never advances past it.
  // Idempotent: real work happens once per process boot.
  ensureRunnerStarted();
  // `?storage=<id>` scopes the list to one drive's jobs (the per-drive log);
  // omitted → the whole instance-wide list.
  const storageRaw = req.nextUrl.searchParams.get('storage');
  const storageId = storageRaw != null && storageRaw !== '' ? Number(storageRaw) : null;
  const jobs = listJobs(100, Number.isFinite(storageId) ? storageId : null);
  return Response.json({ jobs, paused: isPaused() });
}

export async function POST(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;

  let body: { command?: string; args?: Record<string, unknown>; storageId?: number };
  try { body = await req.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  if (typeof body.command !== 'string' || !body.command) {
    return Response.json({ error: 'Missing command' }, { status: 400 });
  }

  // Which drive this run belongs to — tags every enqueued step so the storage
  // admin can show a per-drive job log. null for library-wide / system jobs.
  const storageId = typeof body.storageId === 'number' && Number.isFinite(body.storageId)
    ? body.storageId
    : null;

  // Expand aggregates (enrich:all, backfill:all, setup) into discrete steps
  // so each runs as its own queued job. Non-aggregates expand to themselves.
  const rawArgs = body.args ?? {};
  const steps = expandCommand(body.command);

  const created: AdminJobRow[] = [];
  // Map each step to its enqueued job id so a dependent step can reference the
  // real ids of its prerequisites (only those present in THIS batch).
  const stepJobId = new Map<string, number>();
  for (const stepId of steps) {
    const def = getJobDefinition(stepId);
    if (!def) {
      return Response.json({ error: `Unknown command: ${stepId}` }, { status: 400 });
    }

    // Validate + coerce args against THIS step's declared options. Steps
    // ignore args they don't declare (e.g. backfill steps drop `path`).
    const cleanArgs: Record<string, string | number | boolean> = {};
    for (const opt of def.options) {
      const v = rawArgs[opt.flag];
      if (v === undefined || v === null || v === '') {
        if (opt.required) {
          return Response.json({ error: `${opt.label} is required for ${stepId}` }, { status: 400 });
        }
        continue;
      }
      if (opt.type === 'number') {
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        if (!Number.isFinite(n)) {
          return Response.json({ error: `Invalid number for ${opt.flag}` }, { status: 400 });
        }
        cleanArgs[opt.flag] = n;
      } else if (opt.type === 'boolean') {
        cleanArgs[opt.flag] = v === true || v === 'true';
      } else {
        cleanArgs[opt.flag] = String(v);
      }
    }

    const librarySlug = typeof cleanArgs.library === 'string' ? cleanArgs.library : null;
    // Dependencies present in this batch → the job ids to wait on.
    const dependsOn = (def.dependsOn ?? [])
      .map((d) => stepJobId.get(d))
      .filter((x): x is number => x != null);
    const job = enqueue({
      command: def.id,
      args: cleanArgs,
      librarySlug,
      storageId,
      dependsOn,
      userId: guard.user.id,
    });
    stepJobId.set(stepId, job.id);
    created.push(job);
  }

  // Always return an array. `job` retained for any older caller reading
  // the first element.
  return Response.json({ jobs: created, job: created[0] ?? null });
}
