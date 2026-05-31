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
  librarySlug: string | null;
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
  library_slug: string | null;
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
    librarySlug: r.library_slug,
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
  librarySlug: string | null;
  userId: number;
}): AdminJobRow {
  const db = getUserSqlite();
  const now = Date.now();
  const res = db.prepare(`
    INSERT INTO admin_jobs (
      command, args_json, library_slug, status,
      enqueued_by_user_id, enqueued_at
    ) VALUES (?, ?, ?, 'queued', ?, ?)
  `).run(
    input.command,
    JSON.stringify(input.args),
    input.librarySlug,
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
  // id is the tiebreaker so a batch enqueued in the same millisecond still
  // runs in insertion order (indexer → backfill → enrich).
  const row = db.prepare(`
    SELECT * FROM admin_jobs
    WHERE status = 'queued'
    ORDER BY enqueued_at ASC, id ASC
    LIMIT 1
  `).get() as DbRow | undefined;
  return row ? rowToJob(row) : null;
}

/**
 * Atomically claim a queued job. Returns true only if THIS call flipped the
 * row queued→running. With two server processes both draining the queue
 * (dev :3000 + prod :3001), the loser of the race gets false and must NOT
 * spawn a duplicate child — the WHERE guard makes the transition single-winner.
 */
export function markRunning(id: number): boolean {
  const db = getUserSqlite();
  const res = db.prepare(`
    UPDATE admin_jobs SET status = 'running', started_at = ?
    WHERE id = ? AND status = 'queued'
  `).run(Date.now(), id);
  return Number(res.changes) > 0;
}

/**
 * Put a running job back in the queue — used when a pause gracefully stops
 * the job. The script's per-item status flags mean already-finished work is
 * preserved; on resume the same job re-runs and skips done items. We avoid a
 * dedicated 'paused' status (which would need a CHECK-constraint migration);
 * a paused pipeline is simply "queue flag set + steps queued".
 */
export function requeueJob(id: number): void {
  const db = getUserSqlite();
  db.prepare(`
    UPDATE admin_jobs SET status = 'queued', started_at = NULL
    WHERE id = ? AND status = 'running'
  `).run(id);
}

// ─── Global queue pause flag (persisted in user_settings) ────────────────────
// Single-user v0.1 → user_id = 1. Survives page refresh AND app restart
// because it lives in user.db, so the runner stays paused across boots.
const QUEUE_PAUSED_KEY = 'admin_queue_paused';

export function isQueuePaused(): boolean {
  const db = getUserSqlite();
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE user_id = 1 AND key = ?`,
  ).get(QUEUE_PAUSED_KEY) as { value: string | null } | undefined;
  return row?.value === '1';
}

export function setQueuePaused(paused: boolean): void {
  const db = getUserSqlite();
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(QUEUE_PAUSED_KEY, paused ? '1' : '0', Date.now());
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
