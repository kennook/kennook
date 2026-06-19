/**
 * Optimistic concurrency control (OCC) — the "ETag / version" pattern,
 * generalized for shared, mutable rows. Use this anywhere two clients can
 * write the same record and you want to avoid silent lost updates.
 *
 * THE CONVENTION (apply to any shared-mutable table):
 *   1. Give the table a `version INTEGER NOT NULL DEFAULT 0` column.
 *   2. Reads return the row's `version` alongside its data — that integer IS
 *      the ETag the client holds.
 *   3. Writes send the `baseVersion` they read. The server applies the write
 *      ONLY if the row is still at that version, bumping it by 1. If the row
 *      moved on (someone else wrote), it's a CONFLICT: the write is rejected
 *      and the caller gets the current authoritative row to converge on.
 *
 * This never corrupts data and prevents a stale reader from clobbering a
 * newer value. The caller decides the conflict policy (retry-my-intent,
 * accept-theirs, prompt the user, …) — `occWrite` only does the
 * insert-vs-guarded-update-vs-conflict decision. Callers pass the
 * table-specific SQL as closures, so there's no dynamic SQL here.
 *
 * Reference implementation: `server/routers/mediaView.ts`.
 */

export interface OccWriteResult<T> {
  /** True iff OUR write landed. */
  ok: boolean;
  /** True iff we lost to a concurrent writer (write rejected on version). */
  conflict: boolean;
  /** The authoritative row after the attempt — null if it doesn't exist
   *  (never created, or concurrently deleted). Use it to converge caches. */
  row: T | null;
}

export function occWrite<T>(steps: {
  /** The version the write is based on. 0 ⇒ "I expect no row yet". */
  baseVersion: number;
  /** INSERT … ON CONFLICT DO NOTHING, with version 1. Returns rows inserted. */
  insert: () => number;
  /** Version-guarded UPDATE (… AND version = baseVersion) that bumps version
   *  by 1. Returns rows changed. */
  update: () => number;
  /** Read the current authoritative row after the attempt (or null). */
  read: () => T | null;
}): OccWriteResult<T> {
  const landed = steps.baseVersion <= 0 ? steps.insert() : steps.update();
  return landed > 0
    ? { ok: true, conflict: false, row: steps.read() }
    : { ok: false, conflict: true, row: steps.read() };
}
