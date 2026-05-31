import fs from 'node:fs';
import path from 'node:path';
import type { Sqlite } from '@/db/client';
import type { StorageConfig } from '@/db/schema';

// Resolving an absolute path from a media row means joining the storage
// location's root_path with the row's relative path. Three flavours below:
// - getStorageRootPath:  one row's root, cached lookup per call site
// - resolveMediaPath:    pure join helper for when you already have the root
// - getAbsoluteMediaPath: convenience for one-off lookups (does both)
//
// For batch work (e.g. iterating thousands of media rows), prefer JOINing
// storage_locations in the SELECT and using resolveMediaPath — avoids N+1.

export function getStorageRootPath(sqlite: Sqlite, storageLocationId: number): string {
  const row = sqlite
    .prepare(`SELECT config FROM storage_locations WHERE id = ?`)
    .get(storageLocationId) as { config: string } | undefined;
  if (!row) throw new Error(`storage_location ${storageLocationId} not found`);
  return parseRootPath(row.config);
}

export function parseRootPath(configJson: string): string {
  let cfg: Partial<StorageConfig> & { root?: string } = {};
  try { cfg = JSON.parse(configJson); } catch { /* malformed JSON */ }
  // `root` is the pre-v10 key; the migration rewrites it but we tolerate it
  // here for any edge case where a row slipped through.
  return cfg.root_path ?? cfg.root ?? '/';
}

export function resolveMediaPath(rootPath: string, relPath: string): string {
  return path.join(rootPath, relPath);
}

export function getAbsoluteMediaPath(
  sqlite: Sqlite,
  mediaRow: { storage_location_id: number; path: string },
): string {
  const root = getStorageRootPath(sqlite, mediaRow.storage_location_id);
  return resolveMediaPath(root, mediaRow.path);
}

/**
 * Inverse: given an absolute filesystem path and a storage location, compute
 * the relative path to store in media_items.path. Throws if the abs path is
 * not under the storage's root — caller must route to the correct storage.
 */
export function relativeMediaPath(rootPath: string, absPath: string): string {
  const rel = path.relative(rootPath, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `path "${absPath}" is not under storage root "${rootPath}"`,
    );
  }
  return rel;
}

// ─── Multi-storage routing ─────────────────────────────────────────────────
// A library can have many storage_locations (multiple drives, BYOC clouds,
// etc.). When the indexer encounters an absolute file path, it has to figure
// out which storage that file belongs to. Rule: longest matching root_path
// wins. So a storage at "/Volumes/DriveA/Photos" beats one at "/Volumes/DriveA"
// for files under the more specific tree.
//
// buildStorageRouter loads every storage_location once and returns a tiny
// in-memory router. Use this from the indexer's hot loop so we don't hit the
// DB per file.

export interface StorageMatch {
  id: number;
  root_path: string;
}

export interface StorageRouter {
  /** Returns the matching storage for an absolute path, or null if none. */
  findFor(absPath: string): StorageMatch | null;
  /** Every storage in the library, sorted by root_path length DESC. */
  readonly storages: ReadonlyArray<StorageMatch>;
}

export function buildStorageRouter(sqlite: Sqlite): StorageRouter {
  const rows = sqlite
    .prepare(`SELECT id, config FROM storage_locations`)
    .all() as { id: number; config: string }[];

  const storages: StorageMatch[] = rows
    .map((r) => ({ id: r.id, root_path: parseRootPath(r.config) }))
    .sort((a, b) => b.root_path.length - a.root_path.length);

  return {
    storages,
    findFor(absPath: string) {
      for (const s of storages) {
        if (isPathUnder(absPath, s.root_path)) return s;
      }
      return null;
    },
  };
}

/** True iff `absPath` is the storage root itself or any descendant of it. */
export function isPathUnder(absPath: string, rootPath: string): boolean {
  if (rootPath === '/') return absPath.startsWith('/');
  return absPath === rootPath || absPath.startsWith(rootPath + '/');
}

// ─── CRUD helpers ──────────────────────────────────────────────────────────
// These are the single source of truth for storage_location operations.
// Both the `pnpm storage` CLI and the /admin/storage tRPC router call into
// here so behavior stays consistent and tests can target one place.

export interface StorageInfo {
  id: number;
  name: string;
  type: string;
  root_path: string;
  is_default: boolean;
  /** Does root_path exist on the filesystem right now? Cloud types report `null`. */
  exists: boolean | null;
  /** Number of indexed media_items pointing at this storage. */
  file_count: number;
  /** Epoch-ms timestamp of the last successful indexer run for this storage, or null. */
  last_indexed_at: number | null;
}

export function listStorageInfo(sqlite: Sqlite): StorageInfo[] {
  const rows = sqlite
    .prepare(`SELECT id, name, type, config, is_default, last_indexed_at FROM storage_locations ORDER BY id`)
    .all() as { id: number; name: string; type: string; config: string; is_default: number; last_indexed_at: number | null }[];

  const counts = sqlite
    .prepare(`SELECT storage_location_id AS id, COUNT(*) AS n FROM media_items WHERE deleted_at IS NULL GROUP BY storage_location_id`)
    .all() as { id: number; n: number }[];
  const countMap = new Map(counts.map((c) => [c.id, c.n]));

  return rows.map((r) => {
    const root_path = parseRootPath(r.config);
    const exists = r.type === 'local' ? fs.existsSync(root_path) : null;
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      root_path,
      is_default: r.is_default === 1,
      exists,
      file_count: countMap.get(r.id) ?? 0,
      last_indexed_at: r.last_indexed_at,
    };
  });
}

/**
 * Bump a storage's last_indexed_at to now. Called by the job runner after
 * an `indexer` job completes successfully, against the storage whose root
 * is the longest matching prefix of the job's target path.
 */
export function markStorageIndexed(sqlite: Sqlite, storageId: number, when = Date.now()): void {
  sqlite
    .prepare(`UPDATE storage_locations SET last_indexed_at = ? WHERE id = ?`)
    .run(when, storageId);
}

/**
 * Reject overlap with an existing non-`/` storage. The seeded catch-all at
 * "/" is allowed to coexist with anything so the longest-prefix routing
 * remains unambiguous.
 */
function assertNoOverlap(sqlite: Sqlite, newRoot: string, excludeId?: number) {
  const existing = sqlite
    .prepare(`SELECT id, name, config FROM storage_locations`)
    .all() as { id: number; name: string; config: string }[];
  for (const e of existing) {
    if (excludeId !== undefined && e.id === excludeId) continue;
    const eRoot = parseRootPath(e.config);
    if (eRoot === '/') continue;
    if (isPathUnder(newRoot, eRoot) || isPathUnder(eRoot, newRoot)) {
      throw new Error(
        `new root "${newRoot}" overlaps existing storage [${e.id}] "${e.name}" at "${eRoot}"`,
      );
    }
  }
}

export function createStorage(
  sqlite: Sqlite,
  args: { name: string; root_path: string; type?: 'local' },
): { id: number } {
  const type = args.type ?? 'local';
  if (type !== 'local') throw new Error(`only 'local' storage is supported in v0.1`);

  const absRoot = path.resolve(args.root_path);
  if (!fs.existsSync(absRoot)) throw new Error(`root path does not exist: ${absRoot}`);
  if (!fs.statSync(absRoot).isDirectory()) throw new Error(`root path is not a directory: ${absRoot}`);

  assertNoOverlap(sqlite, absRoot);

  const res = sqlite
    .prepare(
      `INSERT INTO storage_locations (user_id, name, type, config, is_default)
       VALUES (1, ?, ?, ?, 0)`,
    )
    .run(args.name, type, JSON.stringify({ root_path: absRoot }));

  return { id: Number(res.lastInsertRowid) };
}

export function deleteStorage(sqlite: Sqlite, id: number): void {
  const usage = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM media_items WHERE storage_location_id = ? AND deleted_at IS NULL`)
    .get(id) as { n: number };
  if (usage.n > 0) {
    throw new Error(`storage [${id}] still references ${usage.n} media item(s) — reassign or delete them first`);
  }
  const exists = sqlite.prepare(`SELECT 1 FROM storage_locations WHERE id = ?`).get(id);
  if (!exists) throw new Error(`no storage with id ${id}`);
  sqlite.prepare(`DELETE FROM storage_locations WHERE id = ?`).run(id);
}

export function updateStorageRoot(sqlite: Sqlite, id: number, newRootPath: string): void {
  const row = sqlite.prepare(`SELECT config FROM storage_locations WHERE id = ?`).get(id) as { config: string } | undefined;
  if (!row) throw new Error(`no storage with id ${id}`);

  const absRoot = path.resolve(newRootPath);
  if (!fs.existsSync(absRoot)) throw new Error(`new root path does not exist: ${absRoot}`);
  if (!fs.statSync(absRoot).isDirectory()) throw new Error(`new root path is not a directory: ${absRoot}`);

  assertNoOverlap(sqlite, absRoot, id);

  const cfg = JSON.parse(row.config) as Record<string, unknown>;
  cfg.root_path = absRoot;
  delete cfg.root;
  sqlite.prepare(`UPDATE storage_locations SET config = ? WHERE id = ?`).run(JSON.stringify(cfg), id);
}

export interface RelocationSample {
  rel_path: string;
  exists_at_new: boolean;
}

export interface RelocationVerification {
  storage_id: number;
  current_root: string;
  new_root: string;
  new_root_exists: boolean;
  sample_size: number;
  total_files: number;
  samples: RelocationSample[];
  all_samples_present: boolean;
}

/**
 * Dry-run for a relocate: picks N random rows from the storage and checks
 * whether they exist at the proposed new root. Caller decides whether to
 * commit by calling updateStorageRoot after reviewing the result.
 */
export function verifyRelocation(
  sqlite: Sqlite,
  storageId: number,
  newRootPath: string,
  sampleSize = 5,
): RelocationVerification {
  const row = sqlite.prepare(`SELECT config FROM storage_locations WHERE id = ?`).get(storageId) as { config: string } | undefined;
  if (!row) throw new Error(`no storage with id ${storageId}`);
  const currentRoot = parseRootPath(row.config);

  const absNewRoot = path.resolve(newRootPath);
  const newRootExists = fs.existsSync(absNewRoot) && fs.statSync(absNewRoot).isDirectory();

  const totalRow = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM media_items WHERE storage_location_id = ? AND deleted_at IS NULL`)
    .get(storageId) as { n: number };

  const samples = sqlite
    .prepare(
      `SELECT path FROM media_items
       WHERE storage_location_id = ? AND deleted_at IS NULL
       ORDER BY RANDOM() LIMIT ?`,
    )
    .all(storageId, sampleSize) as { path: string }[];

  const sampleResults: RelocationSample[] = samples.map((s) => ({
    rel_path: s.path,
    exists_at_new: newRootExists && fs.existsSync(path.join(absNewRoot, s.path)),
  }));

  return {
    storage_id: storageId,
    current_root: currentRoot,
    new_root: absNewRoot,
    new_root_exists: newRootExists,
    sample_size: samples.length,
    total_files: totalRow.n,
    samples: sampleResults,
    all_samples_present: sampleResults.length > 0 && sampleResults.every((s) => s.exists_at_new),
  };
}
