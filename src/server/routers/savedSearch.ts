/**
 * Per-user, per-library saved searches. A saved search is the query + facet
 * filters + sort that together define a browse/search view — stored in the
 * shared user.db, scoped by ctx.userId, and re-applied client-side via
 * url.set(). View-mode axes (playlist/person/similar), viewport (page/item),
 * and library are intentionally NOT part of a saved search.
 *
 * Mirrors the playlist router's user.db CRUD pattern.
 */

import { z } from 'zod';
import crypto from 'node:crypto';
import { router, publicProcedure } from '@/server/trpc';
import { getUserSqlite } from '@/db/user-client';
import { publishToUser } from '@/server/sync-broker';

// The saveable subset of PageState. `.strict()` rejects any other key (viewport,
// library, view-mode), so only a real search ever gets persisted.
const savedSearchPayload = z.object({
  query: z.string().optional(),
  kind: z.string().nullable().optional(),
  orientation: z.string().nullable().optional(),
  quality: z.string().nullable().optional(),
  cameraMake: z.string().nullable().optional(),
  storage: z.number().nullable().optional(),
  year: z.number().nullable().optional(),
  tags: z.array(z.string()).optional(),
  mentioned: z.array(z.string()).optional(),
  minLikes: z.number().nullable().optional(),
  watched: z.string().nullable().optional(),
  sensitive: z.string().nullable().optional(),
  sort: z.string().nullable().optional(),
}).strict();

interface SavedSearchRow {
  uuid: string;
  name: string;
  library_slug: string;
  search_json: string;
  created_at: number;
}

export const savedSearchRouter = router({
  list: publicProcedure
    .input(z.object({ librarySlug: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      const slug = input?.librarySlug ?? ctx.library.slug;
      const db = getUserSqlite();
      const rows = db.prepare(
        `SELECT uuid, name, library_slug, search_json, created_at
         FROM saved_searches
         WHERE user_id = ? AND library_slug = ?
         ORDER BY updated_at DESC`,
      ).all(ctx.userId, slug) as unknown as SavedSearchRow[];
      return rows.map((r) => ({
        uuid: r.uuid,
        name: r.name,
        librarySlug: r.library_slug,
        createdAt: r.created_at,
        search: JSON.parse(r.search_json) as Record<string, unknown>,
      }));
    }),

  create: publicProcedure
    .input(z.object({
      name: z.string().min(1).max(120),
      librarySlug: z.string().optional(),
      search: savedSearchPayload,
    }))
    .mutation(({ ctx, input }) => {
      const slug = input.librarySlug ?? ctx.library.slug;
      const db = getUserSqlite();
      const uuid = crypto.randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO saved_searches
           (uuid, user_id, library_slug, name, search_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(uuid, ctx.userId, slug, input.name, JSON.stringify(input.search), now, now);
      publishToUser(ctx.userId, { sessionId: ctx.sessionId, event: { type: 'savedSearch.changed' } });
      return { uuid, name: input.name };
    }),

  // Overwrite an existing saved search's query/filters with a new payload
  // (the name is kept). Used by the "update with current search" affordance.
  update: publicProcedure
    .input(z.object({ uuid: z.string(), search: savedSearchPayload }))
    .mutation(({ ctx, input }) => {
      const db = getUserSqlite();
      db.prepare(
        'UPDATE saved_searches SET search_json = ?, updated_at = ? WHERE uuid = ? AND user_id = ?',
      ).run(JSON.stringify(input.search), Date.now(), input.uuid, ctx.userId);
      publishToUser(ctx.userId, { sessionId: ctx.sessionId, event: { type: 'savedSearch.changed' } });
      return { uuid: input.uuid };
    }),

  delete: publicProcedure
    .input(z.object({ uuid: z.string() }))
    .mutation(({ ctx, input }) => {
      const db = getUserSqlite();
      db.prepare('DELETE FROM saved_searches WHERE uuid = ? AND user_id = ?')
        .run(input.uuid, ctx.userId);
      publishToUser(ctx.userId, { sessionId: ctx.sessionId, event: { type: 'savedSearch.changed' } });
      return { ok: true as const };
    }),
});
