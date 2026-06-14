import fs from 'node:fs';
import type { Sqlite } from '@/db/client';
import { getUserSqlite } from '@/db/user-client';

export interface PurgeableRow {
  id: number;
  uuid: string;
  thumbnail_path: string | null;
  preview_path: string | null;
  /** Absolute original-file path — only unlinked when `unlinkOriginal` is set. */
  originalPath?: string | null;
}

/**
 * Hard-remove a media item from a library — the destructive counterpart to the
 * soft `exclude`. Deletes its DB rows (library DB + user.db) and its derived
 * files. Used by the move-to-library flow (which relocates the original first,
 * so it passes `unlinkOriginal: false`); reusable for any future permanent
 * delete.
 *
 * Order matters: the vec0 virtual tables (`media_embeddings`,
 * `media_face_embeddings`) have no foreign keys, so they're deleted manually
 * BEFORE the `media_items` row. Deleting `media_items` then cascades
 * `media_tags` / `media_likes` / `media_views` / `media_faces` /
 * `media_text_occurrences` and fires the `media_fts_del` trigger that cleans the
 * FTS index.
 */
export function purgeMediaItem(
  sqlite: Sqlite,
  librarySlug: string,
  row: PurgeableRow,
  opts: { unlinkOriginal: boolean },
): void {
  sqlite.exec('BEGIN');
  try {
    sqlite
      .prepare(
        `DELETE FROM media_face_embeddings
         WHERE rowid IN (SELECT id FROM media_faces WHERE media_item_id = ?)`,
      )
      .run(row.id);
    sqlite.prepare('DELETE FROM media_embeddings WHERE rowid = ?').run(row.id);
    sqlite.prepare('DELETE FROM media_items WHERE id = ?').run(row.id);
    sqlite.exec('COMMIT');
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }

  // Playlists live in the shared user.db (no FK to per-library rows), so the
  // membership rows must be removed explicitly.
  getUserSqlite()
    .prepare('DELETE FROM playlist_items WHERE library_slug = ? AND item_uuid = ?')
    .run(librarySlug, row.uuid);

  // Derived files. existsSync-guarded so a missing file never throws.
  unlinkIfExists(row.thumbnail_path);
  unlinkIfExists(row.preview_path);
  if (opts.unlinkOriginal) unlinkIfExists(row.originalPath ?? null);
}

function unlinkIfExists(p: string | null | undefined): void {
  if (p && fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch { /* best-effort cleanup */ }
  }
}
