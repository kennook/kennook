import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import { getUserSqlite } from '@/db/user-client';
import { getRawSqlite } from '@/db/client';
import { listLibraries } from '@/server/libraries';
import { LIKE_COUNT_EXPR, markItemViewedByUuid } from './media';
import { publishToUser } from '@/server/sync-broker';

interface PlaylistRow {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  cover_library: string | null;
  cover_item_uuid: string | null;
  created_at: number;
  updated_at: number;
}

interface PlaylistItemRow {
  playlist_id: number;
  library_slug: string;
  item_uuid: string;
  position: number;
  added_at: number;
}

interface MediaItemRow {
  id: number;
  uuid: string;
  filename: string;
  kind: 'photo' | 'video';
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  captured_at: number | null;
  captured_place: string | null;
  camera_make: string | null;
  camera_model: string | null;
  size_bytes: number | null;
  path: string;
  like_count: number;
  rotation: number;
  nsfw_score: number;
  violence_score: number;
  sensitive_override: number | null;
}

const itemRefSchema = z.object({
  librarySlug: z.string(),
  itemUuid: z.string(),
});

export const playlistRouter = router({
  // ── List playlists with item counts. User-scoped. ──────────────────────
  list: publicProcedure.query(({ ctx }) => {
    const db = getUserSqlite();
    const rows = db.prepare(`
      SELECT p.id, p.uuid, p.name, p.description, p.cover_library, p.cover_item_uuid,
             p.created_at, p.updated_at,
             (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count
      FROM playlists p
      WHERE p.user_id = ?
      ORDER BY p.updated_at DESC
    `).all(ctx.userId) as unknown as Array<PlaylistRow & { item_count: number }>;

    return rows.map(rowToPlaylistSummary);
  }),

  // ── Get one playlist + its items (resolved cross-library). ──────────
  get: publicProcedure
    .input(z.object({
      uuid: z.string(),
      limit: z.number().min(1).max(200).default(60),
      offset: z.number().min(0).default(0),
      cursor: z.number().min(0).optional(),
    }))
    .query(({ input, ctx }) => {
      const db = getUserSqlite();
      const playlist = db.prepare(`
        SELECT id, uuid, name, description, cover_library, cover_item_uuid,
               created_at, updated_at
        FROM playlists WHERE uuid = ? AND user_id = ?
      `).get(input.uuid, ctx.userId) as unknown as PlaylistRow | undefined;
      if (!playlist) throw new Error('Playlist not found');

      const totalCount = (db.prepare(
        'SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?',
      ).get(playlist.id) as { n: number }).n;

      const effectiveOffset = input.cursor ?? input.offset;
      const items = db.prepare(`
        SELECT playlist_id, library_slug, item_uuid, position, added_at
        FROM playlist_items
        WHERE playlist_id = ?
        ORDER BY position ASC
        LIMIT ? OFFSET ?
      `).all(playlist.id, input.limit, effectiveOffset) as unknown as PlaylistItemRow[];

      // Resolve each item by querying its library's DB. Items whose
      // library is no longer in the registry or whose item is missing
      // are returned as `null` so the client can show a "missing" state.
      const validLibraries = new Set(listLibraries().map((w) => w.slug));
      const resolved = items.map((it) => {
        if (!validLibraries.has(it.library_slug)) {
          return {
            ...refToBase(it),
            available: false,
            reason: 'library removed' as const,
          };
        }
        try {
          const sqlite = getRawSqlite(it.library_slug);
          // LIKE_COUNT_EXPR's `?` is the user_id (must come first since the
          // subquery lives in SELECT before WHERE's placeholder).
          const row = sqlite.prepare(`
            SELECT m.id, m.uuid, m.filename, m.kind, m.width, m.height, m.duration_ms,
                   m.captured_at, m.captured_place, m.camera_make, m.camera_model,
                   m.size_bytes, m.path, m.rotation, m.nsfw_score, m.violence_score, m.sensitive_override,
                   ${LIKE_COUNT_EXPR}
            FROM media_items m
            WHERE m.uuid = ? AND m.deleted_at IS NULL
          `).get(ctx.userId, it.item_uuid) as unknown as MediaItemRow | undefined;
          if (!row) {
            return {
              ...refToBase(it),
              available: false,
              reason: 'item removed' as const,
            };
          }
          return {
            ...refToBase(it),
            available: true as const,
            item: rowToDto(row, it.library_slug),
          };
        } catch {
          return {
            ...refToBase(it),
            available: false,
            reason: 'library error' as const,
          };
        }
      });

      const hasMore = effectiveOffset + items.length < totalCount;
      return {
        playlist: rowToPlaylistSummary({ ...playlist, item_count: totalCount }),
        items: resolved,
        hasMore,
        totalCount,
        nextCursor: hasMore ? effectiveOffset + items.length : undefined,
      };
    }),

  // ── Create a new playlist. ─────────────────────────────────────────────
  create: publicProcedure
    .input(z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional(),
    }))
    .mutation(({ input, ctx }) => {
      const db = getUserSqlite();
      const uuid = crypto.randomUUID();
      const now = Date.now();
      db.prepare(`
        INSERT INTO playlists (uuid, user_id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuid, ctx.userId, input.name, input.description ?? null, now, now);
      const row = db.prepare(`
        SELECT id, uuid, name, description, cover_library, cover_item_uuid,
               created_at, updated_at
        FROM playlists WHERE uuid = ? AND user_id = ?
      `).get(uuid, ctx.userId) as unknown as PlaylistRow;
      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: { type: 'playlist.changed' },
      });
      return rowToPlaylistSummary({ ...row, item_count: 0 });
    }),

  // ── Rename or describe a playlist. ─────────────────────────────────────
  update: publicProcedure
    .input(z.object({
      uuid: z.string(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(500).optional(),
    }))
    .mutation(({ input, ctx }) => {
      const db = getUserSqlite();
      const fields: string[] = [];
      const params: Array<string | number> = [];
      if (input.name !== undefined) { fields.push('name = ?'); params.push(input.name); }
      if (input.description !== undefined) { fields.push('description = ?'); params.push(input.description); }
      if (fields.length === 0) return { ok: true };
      fields.push('updated_at = ?');
      params.push(Date.now());
      params.push(input.uuid);
      params.push(ctx.userId);
      db.prepare(`UPDATE playlists SET ${fields.join(', ')} WHERE uuid = ? AND user_id = ?`).run(...params);
      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: { type: 'playlist.changed' },
      });
      return { ok: true };
    }),

  // ── Delete a playlist (items cascade). ─────────────────────────────────
  delete: publicProcedure
    .input(z.object({ uuid: z.string() }))
    .mutation(({ input, ctx }) => {
      const db = getUserSqlite();
      db.prepare('DELETE FROM playlists WHERE uuid = ? AND user_id = ?')
        .run(input.uuid, ctx.userId);
      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: { type: 'playlist.changed' },
      });
      return { ok: true };
    }),

  // ── Add one or more items (skipping duplicates). ──────────────────────
  addItems: publicProcedure
    .input(z.object({
      playlistUuid: z.string(),
      items: z.array(itemRefSchema).min(1).max(500),
    }))
    .mutation(({ input, ctx }) => {
      const db = getUserSqlite();
      const playlist = db.prepare(
        'SELECT id FROM playlists WHERE uuid = ? AND user_id = ?',
      ).get(input.playlistUuid, ctx.userId) as { id: number } | undefined;
      if (!playlist) throw new Error('Playlist not found');

      const maxPos = (db.prepare(
        'SELECT COALESCE(MAX(position), -1) AS p FROM playlist_items WHERE playlist_id = ?',
      ).get(playlist.id) as { p: number }).p;

      const insert = db.prepare(`
        INSERT OR IGNORE INTO playlist_items
          (playlist_id, library_slug, item_uuid, position, added_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const updatePlaylistTimestamp = db.prepare(
        'UPDATE playlists SET updated_at = ? WHERE id = ?',
      );
      const setCoverIfMissing = db.prepare(`
        UPDATE playlists
        SET cover_library = ?, cover_item_uuid = ?
        WHERE id = ? AND (cover_item_uuid IS NULL OR cover_item_uuid = '')
      `);

      let added = 0;
      let nextPos = maxPos + 1;
      for (const it of input.items) {
        const res = insert.run(playlist.id, it.librarySlug, it.itemUuid, nextPos, Date.now());
        if (res.changes > 0) {
          added++;
          nextPos++;
          // First item added becomes the cover (only if no cover yet).
          if (added === 1) setCoverIfMissing.run(it.librarySlug, it.itemUuid, playlist.id);
        }
        // Adding to a playlist counts as interaction — even items that were
        // already in the playlist get a view recorded (it was a deliberate
        // action). Cheap upsert; cross-library safe.
        markItemViewedByUuid(it.librarySlug, ctx.userId, it.itemUuid);
      }
      updatePlaylistTimestamp.run(Date.now(), playlist.id);
      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: { type: 'playlist.changed' },
      });
      return { added, skipped: input.items.length - added };
    }),

  // ── Remove one or more items. ──────────────────────────────────────────
  removeItems: publicProcedure
    .input(z.object({
      playlistUuid: z.string(),
      items: z.array(itemRefSchema).min(1),
    }))
    .mutation(({ input, ctx }) => {
      const db = getUserSqlite();
      const playlist = db.prepare(
        'SELECT id FROM playlists WHERE uuid = ? AND user_id = ?',
      ).get(input.playlistUuid, ctx.userId) as { id: number } | undefined;
      if (!playlist) throw new Error('Playlist not found');

      const stmt = db.prepare(`
        DELETE FROM playlist_items
        WHERE playlist_id = ? AND library_slug = ? AND item_uuid = ?
      `);
      let removed = 0;
      for (const it of input.items) {
        const res = stmt.run(playlist.id, it.librarySlug, it.itemUuid);
        if (res.changes > 0) removed++;
      }
      db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
        .run(Date.now(), playlist.id);
      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: { type: 'playlist.changed' },
      });
      return { removed };
    }),
});

// ─── Helpers ────────────────────────────────────────────────────────────

function rowToPlaylistSummary(row: PlaylistRow & { item_count: number }) {
  return {
    uuid: row.uuid,
    name: row.name,
    description: row.description,
    itemCount: row.item_count,
    coverThumbnailUrl: row.cover_item_uuid && row.cover_library
      ? `/api/thumbnails/${row.cover_item_uuid}?lib=${row.cover_library}`
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function refToBase(ref: PlaylistItemRow) {
  return {
    librarySlug: ref.library_slug,
    itemUuid: ref.item_uuid,
    position: ref.position,
    addedAt: ref.added_at,
  };
}

function rowToDto(row: MediaItemRow, librarySlug: string) {
  const qs = `?lib=${librarySlug}`;
  return {
    id: row.id,
    uuid: row.uuid,
    filename: row.filename,
    kind: row.kind,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    capturedAt: row.captured_at,
    capturedPlace: row.captured_place,
    cameraMake: row.camera_make,
    cameraModel: row.camera_model,
    sizeBytes: row.size_bytes,
    likeCount: row.like_count,
    rotation: row.rotation ?? 0,
    nsfwScore: row.nsfw_score ?? 0,
    violenceScore: row.violence_score ?? 0,
    sensitiveOverride: row.sensitive_override ?? null,
    librarySlug,
    thumbnailUrl: `/api/thumbnails/${row.uuid}${qs}`,
    previewUrl: `/api/preview/${row.uuid}${qs}`,
    mediaUrl: `/api/media/${row.uuid}${qs}`,
  };
}
