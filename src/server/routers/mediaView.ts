import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import { getRawSqlite } from '@/db/client';

/**
 * Per-asset viewer framing (pan + zoom), stored in the asset's own library
 * DB and keyed by viewport orientation. Asset-level and shared across clients
 * — a phone (portrait) and a TV (landscape) keep separate framings, but two
 * devices of the same orientation share one (last writer wins). The localized
 * counterpart to the old per-browser localStorage memory.
 */
const orientation = z.enum(['portrait', 'landscape']);

export const mediaViewRouter = router({
  /** The saved framing for an item in a given orientation, or null. */
  get: publicProcedure
    .input(z.object({
      librarySlug: z.string().min(1),
      uuid: z.string().min(1),
      orientation,
    }))
    .query(({ input }) => {
      const sqlite = getRawSqlite(input.librarySlug);
      const row = sqlite.prepare(`
        SELECT v.x AS x, v.y AS y, v.zoom AS zoom
          FROM media_view_state v
          JOIN media_items m ON m.id = v.media_item_id
         WHERE m.uuid = ? AND v.orientation = ?
      `).get(input.uuid, input.orientation) as
        | { x: number; y: number; zoom: number }
        | undefined;
      return row ?? null;
    }),

  /** Upsert the framing. The default view (centered, zoom 1) deletes the row
   *  instead so the table stays sparse — mirrors the old localStorage logic. */
  set: publicProcedure
    .input(z.object({
      librarySlug: z.string().min(1),
      uuid: z.string().min(1),
      orientation,
      x: z.number(),
      y: z.number(),
      zoom: z.number(),
    }))
    .mutation(({ input }) => {
      const sqlite = getRawSqlite(input.librarySlug);
      const item = sqlite.prepare('SELECT id FROM media_items WHERE uuid = ?')
        .get(input.uuid) as { id: number } | undefined;
      if (!item) return { ok: false };

      if (input.x === 0 && input.y === 0 && input.zoom === 1) {
        sqlite.prepare(
          'DELETE FROM media_view_state WHERE media_item_id = ? AND orientation = ?',
        ).run(item.id, input.orientation);
        return { ok: true };
      }

      sqlite.prepare(`
        INSERT INTO media_view_state (media_item_id, orientation, x, y, zoom, updated_at)
          VALUES (?, ?, ?, ?, ?, unixepoch() * 1000)
        ON CONFLICT(media_item_id, orientation)
          DO UPDATE SET x = excluded.x, y = excluded.y, zoom = excluded.zoom,
                        updated_at = excluded.updated_at
      `).run(item.id, input.orientation, input.x, input.y, input.zoom);
      return { ok: true };
    }),
});
