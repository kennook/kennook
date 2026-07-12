import fs from 'node:fs';
import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import { getRawSqlite } from '@/db/client';
import {
  createStorage,
  deleteStorage,
  listStorageInfo,
  updateStorageRoot,
  verifyRelocation,
  getStorageRootPath,
  resolveMediaPath,
  isPathUnder,
} from '@/server/storage';
import { browseStorage, resolveItemsUnder } from '@/server/storage-browse';
import { purgeMediaItem } from '@/server/media-purge';

/** Delete the indexed_files cache for a selection so a later re-index re-evaluates
 *  those paths (subtree for dirs, exact for files). */
function clearIndexedFilesUnder(sqlite: ReturnType<typeof getRawSqlite>, storageId: number, relPaths: string[]): void {
  const exact = sqlite.prepare('DELETE FROM indexed_files WHERE storage_location_id = ? AND path = ?');
  const subtree = sqlite.prepare('DELETE FROM indexed_files WHERE storage_location_id = ? AND path >= ? AND path < ?');
  for (const raw of relPaths) {
    const rel = raw.replace(/^\/+|\/+$/g, '');
    if (!rel) continue;
    exact.run(storageId, rel);
    subtree.run(storageId, `${rel}/`, `${rel}${String.fromCharCode(0x2f + 1)}`);
  }
}

export const storageRouter = router({
  // `librarySlug` lets callers (e.g. the Move-to-library dialog) list a
  // DIFFERENT library's storages than the active one. Defaults to the active.
  list: publicProcedure
    .input(z.object({ librarySlug: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      return listStorageInfo(getRawSqlite(input?.librarySlug ?? ctx.library.slug));
    }),

  // ── File manager ─────────────────────────────────────────────────────────
  // Browse one directory of a storage's real filesystem, annotated with
  // indexed / ignored status. dir is relative to the storage root ('' = root).
  browse: publicProcedure
    .input(z.object({ storageId: z.number().int().positive(), dir: z.string().default('') }))
    .query(({ ctx, input }) => {
      return browseStorage(getRawSqlite(ctx.library.slug), input.storageId, input.dir);
    }),

  // Ignore: remove the selected paths' items from the library AND blacklist the
  // paths so future scans skip the subtree entirely. Files stay on disk.
  ignore: publicProcedure
    .input(z.object({ storageId: z.number().int().positive(), paths: z.array(z.string()).min(1).max(1000) }))
    .mutation(({ ctx, input }) => {
      const sqlite = getRawSqlite(ctx.library.slug);
      const items = resolveItemsUnder(sqlite, input.storageId, input.paths);
      for (const it of items) purgeMediaItem(sqlite, ctx.library.slug, it, { unlinkOriginal: false });
      clearIndexedFilesUnder(sqlite, input.storageId, input.paths);
      const add = sqlite.prepare('INSERT OR IGNORE INTO ignored_paths (storage_location_id, path) VALUES (?, ?)');
      for (const raw of input.paths) { const rel = raw.replace(/^\/+|\/+$/g, ''); if (rel) add.run(input.storageId, rel); }
      return { ignored: input.paths.length, itemsRemoved: items.length };
    }),

  unignore: publicProcedure
    .input(z.object({ storageId: z.number().int().positive(), paths: z.array(z.string()).min(1) }))
    .mutation(({ ctx, input }) => {
      const sqlite = getRawSqlite(ctx.library.slug);
      const del = sqlite.prepare('DELETE FROM ignored_paths WHERE storage_location_id = ? AND path = ?');
      for (const raw of input.paths) { const rel = raw.replace(/^\/+|\/+$/g, ''); if (rel) del.run(input.storageId, rel); }
      return { unignored: input.paths.length };
    }),

  // Remove from library: drop the items (DB rows + thumbnails), leave files on
  // disk. Re-addable by a later re-index (the cache entry is cleared).
  removeFromLibrary: publicProcedure
    .input(z.object({ storageId: z.number().int().positive(), paths: z.array(z.string()).min(1).max(1000) }))
    .mutation(({ ctx, input }) => {
      const sqlite = getRawSqlite(ctx.library.slug);
      const items = resolveItemsUnder(sqlite, input.storageId, input.paths);
      for (const it of items) purgeMediaItem(sqlite, ctx.library.slug, it, { unlinkOriginal: false });
      clearIndexedFilesUnder(sqlite, input.storageId, input.paths);
      return { itemsRemoved: items.length };
    }),

  // Delete from disk: PERMANENT. Remove the items from the library, then delete
  // the actual files/folders on disk (recursively for dirs — nukes non-media
  // junk too). Guarded so it can only touch paths under the storage root.
  deleteFromDisk: publicProcedure
    .input(z.object({ storageId: z.number().int().positive(), paths: z.array(z.string()).min(1).max(1000) }))
    .mutation(({ ctx, input }) => {
      const sqlite = getRawSqlite(ctx.library.slug);
      const root = getStorageRootPath(sqlite, input.storageId);
      const items = resolveItemsUnder(sqlite, input.storageId, input.paths);
      for (const it of items) purgeMediaItem(sqlite, ctx.library.slug, it, { unlinkOriginal: false });
      clearIndexedFilesUnder(sqlite, input.storageId, input.paths);
      let deleted = 0;
      for (const raw of input.paths) {
        const rel = raw.replace(/^\/+|\/+$/g, '');
        if (!rel) continue;
        const abs = resolveMediaPath(root, rel);
        // Never delete outside the storage root, and never the root itself.
        if (abs === root || !isPathUnder(abs, root)) continue;
        try { fs.rmSync(abs, { recursive: true, force: true }); deleted++; } catch { /* best effort */ }
      }
      return { itemsRemoved: items.length, pathsDeleted: deleted };
    }),

  // Cheap existence/type probe for the AddStorage / Relocate dialog inputs.
  // Lets the UI validate paths before the user commits.
  testPath: publicProcedure
    .input(z.object({ path: z.string().min(1) }))
    .query(({ input }) => {
      const exists = fs.existsSync(input.path);
      const isDirectory = exists && fs.statSync(input.path).isDirectory();
      return { exists, isDirectory };
    }),

  add: publicProcedure
    .input(z.object({
      name: z.string().min(1).max(80),
      root_path: z.string().min(1),
    }))
    .mutation(({ ctx, input }) => {
      return createStorage(getRawSqlite(ctx.library.slug), input);
    }),

  remove: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => {
      deleteStorage(getRawSqlite(ctx.library.slug), input.id);
      return { ok: true as const };
    }),

  setRoot: publicProcedure
    .input(z.object({
      id: z.number().int().positive(),
      new_root_path: z.string().min(1),
    }))
    .mutation(({ ctx, input }) => {
      updateStorageRoot(getRawSqlite(ctx.library.slug), input.id, input.new_root_path);
      return { ok: true as const };
    }),

  // Dry-run for the Relocate flow: pick a sample of files from this storage
  // and verify they exist at the proposed new root. UI shows the result;
  // user confirms; UI then calls `setRoot` to commit.
  verifyRelocation: publicProcedure
    .input(z.object({
      id: z.number().int().positive(),
      new_root_path: z.string().min(1),
      sample_size: z.number().int().min(1).max(50).default(5),
    }))
    .query(({ ctx, input }) => {
      return verifyRelocation(
        getRawSqlite(ctx.library.slug),
        input.id,
        input.new_root_path,
        input.sample_size,
      );
    }),
});
