/**
 * Shared `--storage <id>` support for per-drive enrichment/backfill.
 *
 * When the admin runs a step for a single drive (Disk-Utility-style storage
 * admin), the runner passes `--storage <storage_location_id>` and the script
 * scopes its pending-item query to that one storage. Omitting it keeps the
 * old library-wide behavior.
 *
 * The id is always a validated integer, so `storageClause` inlines it into SQL
 * safely (no bind param needed — matches how these scripts inline `LIMIT`).
 */

/** Parse `--storage <id>` / `--storage=<id>` sitting at argv[i]. Returns the
 *  parsed id and how many argv slots it consumed (1 for `--storage=`, 2 for the
 *  space form), or null when argv[i] isn't the storage flag. */
export function matchStorageArg(argv: string[], i: number): { storage: number; consumed: number } | null {
  const a = argv[i];
  if (a === '--storage') {
    const v = argv[i + 1];
    const n = v != null ? parseInt(v, 10) : NaN;
    if (!Number.isFinite(n)) throw new Error('--storage requires a numeric id');
    return { storage: n, consumed: 2 };
  }
  if (a.startsWith('--storage=')) {
    const n = parseInt(a.split('=')[1], 10);
    if (!Number.isFinite(n)) throw new Error('--storage requires a numeric id');
    return { storage: n, consumed: 1 };
  }
  return null;
}

/** SQL fragment scoping a media_items query to one storage. Empty string when
 *  no storage is set. `col` lets a joined query pass e.g. 'm.storage_location_id'. */
export function storageClause(storageId: number | null | undefined, col = 'storage_location_id'): string {
  return storageId != null ? ` AND ${col} = ${Math.trunc(storageId)}` : '';
}
