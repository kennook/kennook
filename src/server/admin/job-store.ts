/**
 * Persistence layer for admin_jobs (user.db). Pure DB operations,
 * no process/runner concerns — the runner module composes these
 * with `child_process` to actually execute jobs.
 *
 * Output is stored inline on the row (a single TEXT column). For
 * Phase 2 this is fine: most jobs produce <100 KB of output, and
 * truncating beyond a cap keeps unbounded growth in check. If
 * jobs grow much chattier, split this to a per-job append-only
 * file under data/admin-jobs/<id>.log.
 */

import { getUserSqlite } from '@/db/user-client';
import type { ProgressPayload } from './progress-protocol';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface AdminJobRow {
  id: number;
  command: string;
  args: Record<string, string | number | boolean>;
  workspaceSlug: string | null;
  status: JobStatus;
  output: string;
  exitCode: number | null;
  enqueuedByUserId: number;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Latest parsed progress emission from the script, or null if the
   *  script hasn't emitted any (or doesn't use the protocol). */
  progress: ProgressPayload | null;
}

interface DbRow {
  id: number;
  command: string;
  args_json: string;
  workspace_slug: string | null;
  status: JobStatus;
  output: string;
  exit_code: number | null;
  enqueued_by_user_id: number;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  progress_json: string | null;
}

function rowToJob(r: DbRow): AdminJobRow {
  let args: Record<string, string | number | boolean> = {};
  try { args = JSON.parse(r.args_json) as typeof args; } catch { args = {}; }
  let progress: ProgressPayload | null = null;
  if (r.progress_json) {
    try { progress = JSON.parse(r.progress_json) as ProgressPayload; } catch { /* ignore */ }
  }
  return {
    id: r.id,
    command: r.command,
    args,
    workspaceSlug: r.workspace_slug,
    status: r.status,
    output: r.output,
    exitCode: r.exit_code,
    enqueuedByUserId: r.enqueued_by_user_id,
    enqueuedAt: r.enqueued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    progress,
  };
}

const OUTPUT_MAX_BYTES = 256 * 1024; // 256 KB cap per job

export function enqueueJob(input: {
  command: string;
  args: Record<string, string | number | boolean>;
  workspaceSlug: string | null;
  userId: number;
}): AdminJobRow {
  const db = getUserSqlite();
  const now = Date.now();
  const res = db.prepare(`
    INSERT INTO admin_jobs (
      command, args_json, workspace_slug, status,
      enqueued_by_user_id, enqueued_at
    ) VALUES (?, ?, ?, 'queued', ?, ?)
  `).run(
    input.command,
    JSON.stringify(input.args),
    input.workspaceSlug,
    input.userId,
    now,
  );
  return getJob(Number(res.lastInsertRowid))!;
}

export function getJob(id: number): AdminJobRow | null {
  const db = getUserSqlite();
  const row = db.prepare(`SELECT * FROM admin_jobs WHERE id = ?`).get(id) as
    DbRow | undefined;
  return row ? rowToJob(row) : null;
}

export function listJobs(limit = 50): AdminJobRow[] {
  const db = getUserSqlite();
  const rows = db.prepare(`
    SELECT * FROM admin_jobs
    ORDER BY enqueued_at DESC
    LIMIT ?
  `).all(limit) as unknown as DbRow[];
  return rows.map(rowToJob);
}

export function nextQueuedJob(): AdminJobRow | null {
  const db = getUserSqlite();
  const row = db.prepare(`
    SELECT * FROM admin_jobs
    WHERE status = 'queued'
    ORDER BY enqueued_at ASC
    LIMIT 1
  `).get() as DbRow | undefined;
  return row ? rowToJob(row) : null;
}

export function markRunning(id: number): void {
  const db = getUserSqlite();
  db.prepare(`
    UPDATE admin_jobs SET status = 'running', started_at = ?
    WHERE id = ? AND status = 'queued'
  `).run(Date.now(), id);
}

export function appendOutput(id: number, chunk: string): void {
  const db = getUserSqlite();
  // Truncate from the FRONT when over cap — most operators care about
  // the tail of the log (the part with the error), not the head.
  db.prepare(`
    UPDATE admin_jobs
    SET output = substr(output || ?, max(1, length(output || ?) - ? + 1))
    WHERE id = ?
  `).run(chunk, chunk, OUTPUT_MAX_BYTES, id);
}

export function setProgress(id: number, payload: ProgressPayload): void {
  const db = getUserSqlite();
  db.prepare(`UPDATE admin_jobs SET progress_json = ? WHERE id = ?`)
    .run(JSON.stringify(payload), id);
}

export function markFinished(input: {
  id: number;
  status: 'completed' | 'failed' | 'canceled';
  exitCode: number | null;
}): void {
  const db = getUserSqlite();
  db.prepare(`
    UPDATE admin_jobs
    SET status = ?, exit_code = ?, finished_at = ?
    WHERE id = ? AND status = 'running'
  `).run(input.status, input.exitCode, Date.now(), input.id);
}

export function cancelQueuedJob(id: number): boolean {
  const db = getUserSqlite();
  const res = db.prepare(`
    UPDATE admin_jobs
    SET status = 'canceled', finished_at = ?
    WHERE id = ? AND status = 'queued'
  `).run(Date.now(), id);
  return Number(res.changes) > 0;
}

/**
 * On server restart, any job left as 'running' has lost its process —
 * mark it failed so the queue can move on. Run from the runner's
 * boot path before it starts polling.
 */
export function reapOrphanedRunningJobs(): number {
  const db = getUserSqlite();
  const res = db.prepare(`
    UPDATE admin_jobs
    SET status = 'failed', exit_code = -1, finished_at = ?,
        output = output || char(10) || '[orphaned — server restarted before completion]'
    WHERE status = 'running'
  `).run(Date.now());
  return Number(res.changes);
}
