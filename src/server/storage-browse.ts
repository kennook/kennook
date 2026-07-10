/**
 * Backend for the admin Storage file manager: browse a storage's real
 * filesystem tree (with per-entry "indexed" / "ignored" status), resolve a
 * selection of paths down to the media_items beneath them (for bulk actions),
 * and manage the user ignore-list the indexer honours.
 *
 * All paths in the DB (media_items.path, ignored_paths.path) are RELATIVE to
 * the storage's root_path. This module speaks the same relative-path language.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Sqlite } from '@/db/client';
import { getStorageRootPath, parseRootPath } from '@/server/storage';
import { IMAGE_EXTS, VIDEO_EXTS } from '@/indexer/media-extensions';

export interface BrowseEntry {
  name: string;
  /** Path relative to the storage root. */
  path: string;
  kind: 'dir' | 'file';
  /** Files only: byte size + media classification. */
  sizeBytes?: number;
  mediaKind?: 'photo' | 'video' | null;
  /** File: is it in the library? Dir: does it contain ≥1 indexed item? */
  indexed: boolean;
  /** File: seen by the indexer but not stored — i.e. a content-duplicate of an
   *  already-indexed file (skipped on purpose, so "not indexed" would mislead). */
  duplicate?: boolean;
  /** For a duplicate: the stored original it's byte-identical to (same storage). */
  dupOf?: { uuid: string; path: string };
  /** Indexed files: the media_items uuid, for preview / open-in-app links. */
  uuid?: string;
  /** Dirs only: how many indexed items live under this subtree. */
  indexedCount?: number;
  /** This path (or an ancestor) is on the ignore list. */
  ignored: boolean;
}

export interface BrowseResult {
  storageId: number;
  root: string;
  /** Relative dir being listed ('' = storage root). */
  dir: string;
  exists: boolean;
  entries: BrowseEntry[];
}

function mediaKindFor(name: string): 'photo' | 'video' | null {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXTS.has(ext) ? 'photo' : VIDEO_EXTS.has(ext) ? 'video' : null;
}

/** The set of ignore-list paths for a storage (relative). */
function ignoredSetFor(sqlite: Sqlite, storageId: number): Set<string> {
  const rows = sqlite
    .prepare('SELECT path FROM ignored_paths WHERE storage_location_id = ?')
    .all(storageId) as Array<{ path: string }>;
  return new Set(rows.map((r) => r.path));
}

/** Is `relPath` itself, or any ancestor directory, on the ignore set? */
function isIgnored(relPath: string, ignored: Set<string>): boolean {
  if (ignored.size === 0) return false;
  if (ignored.has(relPath)) return true;
  let p = relPath;
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/')) {
    p = p.slice(0, i);
    if (ignored.has(p)) return true;
  }
  return false;
}

/** Prefix range [dir/ , dir<next>) that captures every path strictly under
 *  `dir` (relative). '/' is 0x2F, so the upper bound is dir + 0x30 ('0'). */
function subtreeRange(dir: string): [string, string] {
  const lo = dir === '' ? '' : `${dir}/`;
  const hi = dir === '' ? '￿' : `${dir}${String.fromCharCode(0x2f + 1)}`;
  return [lo, hi];
}

/**
 * List one directory of a storage's filesystem, annotating each child with its
 * indexed + ignored status. Directories are sorted first, then files, both
 * alphabetically (case-insensitive).
 */
export function browseStorage(sqlite: Sqlite, storageId: number, relDir: string): BrowseResult {
  const root = getStorageRootPath(sqlite, storageId);
  const cleanDir = relDir.replace(/^\/+|\/+$/g, ''); // normalize: no leading/trailing slash
  const absDir = cleanDir === '' ? root : path.join(root, cleanDir);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { storageId, root, dir: cleanDir, exists: false, entries: [] };
  }

  const ignored = ignoredSetFor(sqlite, storageId);

  // One query for every indexed item under this dir, bucketed by immediate
  // child so subdir counts + file-indexed flags come from a single scan.
  const [lo, hi] = subtreeRange(cleanDir);
  const indexedRows = sqlite
    .prepare(`SELECT path, uuid FROM media_items WHERE storage_location_id = ? AND path >= ? AND path < ? AND deleted_at IS NULL`)
    .all(storageId, lo, hi) as Array<{ path: string; uuid: string }>;
  const prefixLen = cleanDir === '' ? 0 : cleanDir.length + 1;
  const dirCounts = new Map<string, number>();   // immediate child dir → indexed count
  const indexedFiles = new Map<string, string>(); // exact indexed file path → uuid
  for (const r of indexedRows) {
    const rest = r.path.slice(prefixLen);
    const slash = rest.indexOf('/');
    if (slash === -1) indexedFiles.set(r.path, r.uuid);  // a file directly here
    else dirCounts.set(rest.slice(0, slash), (dirCounts.get(rest.slice(0, slash)) ?? 0) + 1);
  }

  // Files the indexer has SEEN (indexed_files) but that aren't stored above are
  // content-duplicates — track path→sha so the UI can label them "duplicate"
  // and link to the stored original (same content hash).
  const seenRows = sqlite
    .prepare(`SELECT path, sha256 FROM indexed_files WHERE storage_location_id = ? AND path >= ? AND path < ?`)
    .all(storageId, lo, hi) as Array<{ path: string; sha256: string }>;
  const seenSha = new Map<string, string>(); // direct-file path → sha256
  for (const r of seenRows) {
    const rest = r.path.slice(prefixLen);
    if (rest.indexOf('/') === -1) seenSha.set(r.path, r.sha256);
  }

  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    const name = d.name;
    const relPath = cleanDir === '' ? name : `${cleanDir}/${name}`;
    if (d.isDirectory()) {
      const count = dirCounts.get(name) ?? 0;
      entries.push({ name, path: relPath, kind: 'dir', indexed: count > 0, indexedCount: count, ignored: isIgnored(relPath, ignored) });
    } else if (d.isFile()) {
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(path.join(absDir, name)).size; } catch { /* unreadable */ }
      const isIndexed = indexedFiles.has(relPath);
      entries.push({
        name, path: relPath, kind: 'file', sizeBytes,
        mediaKind: mediaKindFor(name),
        indexed: isIndexed,
        duplicate: !isIndexed && seenSha.has(relPath),
        uuid: indexedFiles.get(relPath),
        ignored: isIgnored(relPath, ignored),
      });
    }
  }

  // Resolve each duplicate's stored original (byte-identical, same storage) in
  // one batched query, so the UI can link to it.
  const dupEntries = entries.filter((e) => e.duplicate);
  if (dupEntries.length > 0) {
    const shas = [...new Set(dupEntries.map((e) => seenSha.get(e.path)!))];
    const placeholders = shas.map(() => '?').join(',');
    const origs = sqlite
      .prepare(`SELECT uuid, path, sha256 FROM media_items WHERE storage_location_id = ? AND sha256 IN (${placeholders}) AND deleted_at IS NULL`)
      .all(storageId, ...shas) as Array<{ uuid: string; path: string; sha256: string }>;
    const bySha = new Map(origs.map((o) => [o.sha256, { uuid: o.uuid, path: o.path }]));
    for (const e of dupEntries) { const o = bySha.get(seenSha.get(e.path)!); if (o) e.dupOf = o; }
  }

  entries.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { storageId, root, dir: cleanDir, exists: true, entries };
}

export interface ResolvedItem {
  id: number;
  uuid: string;
  path: string;
  thumbnail_path: string | null;
  preview_path: string | null;
}

/**
 * Resolve a selection of relative paths (files and/or directories under one
 * storage) to the concrete, non-deleted media_items they cover — the input for
 * bulk exclude / delete / move. A file path matches itself; a dir matches its
 * whole subtree. De-duplicated by item id.
 */
export function resolveItemsUnder(sqlite: Sqlite, storageId: number, relPaths: string[]): ResolvedItem[] {
  const byId = new Map<number, ResolvedItem>();
  const exact = sqlite.prepare(
    `SELECT id, uuid, path, thumbnail_path, preview_path FROM media_items
     WHERE storage_location_id = ? AND path = ? AND deleted_at IS NULL`,
  );
  const subtree = sqlite.prepare(
    `SELECT id, uuid, path, thumbnail_path, preview_path FROM media_items
     WHERE storage_location_id = ? AND path >= ? AND path < ? AND deleted_at IS NULL`,
  );
  for (const raw of relPaths) {
    const rel = raw.replace(/^\/+|\/+$/g, '');
    if (rel === '') continue;
    for (const r of exact.all(storageId, rel) as unknown as ResolvedItem[]) byId.set(r.id, r);
    const [lo, hi] = subtreeRange(rel);
    for (const r of subtree.all(storageId, lo, hi) as unknown as ResolvedItem[]) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** Absolute paths on the ignore-list across all local storages of a library —
 *  used by the indexer walk to skip ignored subtrees entirely. */
export function absoluteIgnoredPaths(sqlite: Sqlite): string[] {
  const rows = sqlite.prepare(`
    SELECT sl.config AS config, ip.path AS path
    FROM ignored_paths ip JOIN storage_locations sl ON sl.id = ip.storage_location_id
  `).all() as Array<{ config: string; path: string }>;
  return rows.map((r) => path.join(parseRootPath(r.config), r.path));
}
