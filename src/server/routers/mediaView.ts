import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import { getRawSqlite } from '@/db/client';
import { occWrite } from '@/server/occ';
import { publishToUser } from '@/server/sync-broker';

/**
 * Per-asset viewer framing (pan + zoom), stored in the asset's own library
 * DB and keyed by viewport orientation. Asset-level and shared across clients
 * — a phone (portrait) and a TV (landscape) keep separate framings.
 *
 * Concurrency: this is the reference implementation of the OCC/version
 * convention (see server/occ.ts). `get` returns a `version`; `set` is guarded
 * on `baseVersion` so a stale writer can't silently clobber a newer framing,
 * and on success it fans out a `mediaView.changed` sync event so other open
 * clients refresh their cache.
 */
const orientation = z.enum(['portrait', 'landscape']);
const fit = z.enum(['cover', 'contain']);

interface ViewRow { x: number; y: number; zoom: number; version: number }

export const mediaViewRouter = router({
  /** The saved framing for an item in a given orientation, or null. The
   *  `version` is the client's ETag for the next write. */
  get: publicProcedure
    .input(z.object({
      librarySlug: z.string().min(1),
      uuid: z.string().min(1),
      orientation,
    }))
    .query(({ input }): ViewRow | null => {
      const sqlite = getRawSqlite(input.librarySlug);
      const row = sqlite.prepare(`
        SELECT v.x AS x, v.y AS y, v.zoom AS zoom, v.version AS version
          FROM media_view_state v
          JOIN media_items m ON m.id = v.media_item_id
         WHERE m.uuid = ? AND v.orientation = ?
      `).get(input.uuid, input.orientation) as ViewRow | undefined;
      return row ?? null;
    }),

  /**
   * Version-guarded upsert. Returns { ok, conflict, row } — on conflict, `row`
   * is the current authoritative value to converge on. We no longer delete
   * "default" rows: keeping them makes `version` monotonic, which OCC needs.
   */
  set: publicProcedure
    .input(z.object({
      librarySlug: z.string().min(1),
      uuid: z.string().min(1),
      orientation,
      x: z.number(),
      y: z.number(),
      zoom: z.number(),
      fit,
      baseVersion: z.number().int().nonnegative(),
    }))
    .mutation(({ input, ctx }) => {
      const sqlite = getRawSqlite(input.librarySlug);
      const item = sqlite.prepare('SELECT id FROM media_items WHERE uuid = ?')
        .get(input.uuid) as { id: number } | undefined;
      if (!item) return { ok: false, conflict: false, row: null as ViewRow | null };
      const id = item.id;

      const result = occWrite<ViewRow>({
        baseVersion: input.baseVersion,
        insert: () => Number(sqlite.prepare(`
          INSERT INTO media_view_state
              (media_item_id, orientation, x, y, zoom, fit, version, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, unixepoch() * 1000)
          ON CONFLICT(media_item_id, orientation) DO NOTHING
        `).run(id, input.orientation, input.x, input.y, input.zoom, input.fit).changes),
        update: () => Number(sqlite.prepare(`
          UPDATE media_view_state
             SET x = ?, y = ?, zoom = ?, fit = ?,
                 version = version + 1, updated_at = unixepoch() * 1000
           WHERE media_item_id = ? AND orientation = ? AND version = ?
        `).run(input.x, input.y, input.zoom, input.fit, id, input.orientation, input.baseVersion).changes),
        read: () => (sqlite.prepare(`
          SELECT x, y, zoom, version FROM media_view_state
           WHERE media_item_id = ? AND orientation = ?
        `).get(id, input.orientation) as ViewRow | undefined) ?? null,
      });

      if (result.ok) {
        // Fan out so other open clients refresh this key's cache. Originating
        // tab skips its own echo via the session id.
        publishToUser(ctx.userId, {
          sessionId: ctx.sessionId,
          event: {
            type: 'mediaView.changed',
            librarySlug: input.librarySlug,
            uuid: input.uuid,
            orientation: input.orientation,
          },
        });
      }
      return result;
    }),
});
