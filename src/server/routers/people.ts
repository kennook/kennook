import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import { getUserSqlite } from '@/db/user-client';
import { getRawSqlite, type Statement } from '@/db/client';
import { listWorkspaces } from '@/server/workspaces';
import { LIKE_COUNT_EXPR } from './media';

interface PersonRow {
  id: number;
  uuid: string;
  name: string | null;
  cover_face_id: number | null;
  cover_workspace_slug: string | null;
  face_count: number;
  created_at: number;
  updated_at: number;
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
}

function rowToDto(row: MediaItemRow, workspaceSlug: string) {
  const qs = `?ws=${workspaceSlug}`;
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
    workspaceSlug,
    thumbnailUrl: `/api/thumbnails/${row.uuid}${qs}`,
    previewUrl: `/api/preview/${row.uuid}${qs}`,
    mediaUrl: `/api/media/${row.uuid}${qs}`,
  };
}

/**
 * Resolve a cover thumbnail URL for a person. The cover row lives in
 * `people` (user.db) but its `cover_face_id` points at a row in a
 * specific workspace's `media_faces` table — so we look up the parent
 * media item there to get the uuid that the thumbnail route serves.
 */
function coverThumbnailUrl(
  coverFaceId: number | null,
  coverWorkspaceSlug: string | null,
): string | null {
  if (!coverFaceId || !coverWorkspaceSlug) return null;
  try {
    const sqlite = getRawSqlite(coverWorkspaceSlug);
    const row = sqlite.prepare(`
      SELECT m.uuid FROM media_faces mf
      JOIN media_items m ON m.id = mf.media_item_id
      WHERE mf.id = ? AND m.deleted_at IS NULL
    `).get(coverFaceId) as { uuid: string } | undefined;
    if (!row) return null;
    return `/api/thumbnails/${row.uuid}?ws=${coverWorkspaceSlug}`;
  } catch {
    return null;
  }
}

export const peopleRouter = router({
  // ── List people. Sorted by face_count first regardless of label, so
  // unnamed clusters with many appearances aren't buried beneath
  // sparsely-attested labeled ones. At the same count, named precedes
  // unnamed (alphabetical), with updated_at as a final tiebreaker. We
  // skip orphans (face_count = 0) which shouldn't exist after clustering
  // but we tolerate. ────────────────────────────────────────────────
  list: publicProcedure.query(({ ctx }) => {
    const db = getUserSqlite();
    const rows = db.prepare(`
      SELECT id, uuid, name, cover_face_id, cover_workspace_slug, face_count,
             created_at, updated_at
      FROM people
      WHERE user_id = ? AND face_count > 0
      ORDER BY face_count DESC,
               CASE WHEN name IS NULL THEN 1 ELSE 0 END,
               name COLLATE NOCASE ASC,
               updated_at DESC
    `).all(ctx.userId) as unknown as PersonRow[];

    return rows.map((p) => ({
      uuid: p.uuid,
      name: p.name,
      faceCount: p.face_count,
      coverThumbnailUrl: coverThumbnailUrl(p.cover_face_id, p.cover_workspace_slug),
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }));
  }),

  // ── Fetch one person + their photos (cross-workspace, paginated).
  // We aggregate across workspaces in memory then sort + slice. Fine for
  // the typical face-count distribution; if any single person ever has
  // > ~10k photos we'd want to push the sort/pagination into SQL using
  // an UNION across attached workspace DBs. ─────────────────────────
  get: publicProcedure
    .input(z.object({
      uuid: z.string(),
      limit: z.number().min(1).max(200).default(60),
      offset: z.number().min(0).default(0),
      cursor: z.number().min(0).optional(),
    }))
    .query(({ input, ctx }) => {
      const db = getUserSqlite();
      const person = db.prepare(`
        SELECT id, uuid, name, cover_face_id, cover_workspace_slug, face_count,
               created_at, updated_at
        FROM people WHERE uuid = ? AND user_id = ?
      `).get(input.uuid, ctx.userId) as unknown as PersonRow | undefined;
      if (!person) throw new Error('Person not found');

      const aggregated: Array<{
        item: ReturnType<typeof rowToDto>;
        sortKey: number;
      }> = [];

      for (const ws of listWorkspaces()) {
        try {
          const sqlite = getRawSqlite(ws.slug);
          // DISTINCT in case a single image has multiple faces of this
          // person (group photos with the same person matched twice by
          // the detector — rare but possible).
          const items = sqlite.prepare(`
            SELECT DISTINCT m.id, m.uuid, m.filename, m.kind, m.width, m.height, m.duration_ms,
                   m.captured_at, m.captured_place, m.camera_make, m.camera_model,
                   m.size_bytes, m.path, m.rotation, m.nsfw_score, m.violence_score,
                   ${LIKE_COUNT_EXPR}
            FROM media_items m
            JOIN media_faces mf ON mf.media_item_id = m.id
            WHERE mf.person_id = ? AND m.deleted_at IS NULL
          `).all(ctx.userId, person.id) as unknown as MediaItemRow[];

          for (const r of items) {
            aggregated.push({
              item: rowToDto(r, ws.slug),
              sortKey: r.captured_at ?? 0,
            });
          }
        } catch {
          // Workspace gone or unreadable — skip it.
        }
      }

      aggregated.sort((a, b) => b.sortKey - a.sortKey);

      const effectiveOffset = input.cursor ?? input.offset;
      const slice = aggregated.slice(effectiveOffset, effectiveOffset + input.limit);
      const hasMore = effectiveOffset + slice.length < aggregated.length;

      return {
        person: {
          uuid: person.uuid,
          name: person.name,
          faceCount: person.face_count,
          coverThumbnailUrl: coverThumbnailUrl(
            person.cover_face_id,
            person.cover_workspace_slug,
          ),
        },
        items: slice.map((s) => s.item),
        totalCount: aggregated.length,
        hasMore,
        nextCursor: hasMore ? effectiveOffset + input.limit : undefined,
      };
    }),

  rename: publicProcedure
    .input(z.object({
      uuid: z.string(),
      name: z.string().max(120).nullable(),
    }))
    .mutation(({ input, ctx }) => {
      const db = getUserSqlite();
      const trimmed = input.name?.trim();
      const final = trimmed && trimmed.length > 0 ? trimmed : null;
      db.prepare(`
        UPDATE people SET name = ?, updated_at = ?
        WHERE uuid = ? AND user_id = ?
      `).run(final, Date.now(), input.uuid, ctx.userId);
      return { uuid: input.uuid, name: final };
    }),

  // ── Merge `src` into `dst`. All faces previously assigned to src get
  // reassigned to dst across every workspace; src is deleted. Used to
  // fix split clusters (the same person showing up under two ids
  // because their photos didn't all link via the distance threshold).
  merge: publicProcedure
    .input(z.object({
      srcUuid: z.string(),
      dstUuid: z.string(),
    }))
    .mutation(({ input, ctx }) => {
      if (input.srcUuid === input.dstUuid) return { movedFaces: 0 };
      const db = getUserSqlite();
      const src = db.prepare(
        'SELECT id FROM people WHERE uuid = ? AND user_id = ?',
      ).get(input.srcUuid, ctx.userId) as { id: number } | undefined;
      const dst = db.prepare(
        'SELECT id FROM people WHERE uuid = ? AND user_id = ?',
      ).get(input.dstUuid, ctx.userId) as { id: number } | undefined;
      if (!src || !dst) throw new Error('Person not found');

      let moved = 0;
      for (const ws of listWorkspaces()) {
        const res = getRawSqlite(ws.slug).prepare(
          'UPDATE media_faces SET person_id = ? WHERE person_id = ?',
        ).run(dst.id, src.id);
        moved += Number(res.changes);
      }

      // Recompute face_count for the destination.
      let total = 0;
      for (const ws of listWorkspaces()) {
        const c = getRawSqlite(ws.slug).prepare(
          'SELECT COUNT(*) AS n FROM media_faces WHERE person_id = ?',
        ).get(dst.id) as { n: number };
        total += c.n;
      }
      db.prepare(`
        UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?
      `).run(total, Date.now(), dst.id);

      db.prepare('DELETE FROM people WHERE id = ?').run(src.id);
      return { movedFaces: moved };
    }),

  // ── Reassign one or more items' faces from one person to another (or
  // unassign, or split into a fresh new person). Use cases:
  //   • Viewer: a single misidentified photo → array of one item.
  //   • Selection bar: bulk fix when the user spots several mistakes →
  //     array of N items.
  //
  // For each item we touch the face(s) currently assigned to
  // `fromPersonUuid`. If a photo has multiple faces all matching the same
  // person (rare; one box per person is typical), we reassign all of them.
  // Items where no matching face exists are silently skipped — easier
  // mental model than throwing per-item errors during a batch.
  reassignFaces: publicProcedure
    .input(z.object({
      items: z.array(z.object({
        workspaceSlug: z.string(),
        itemUuid: z.string(),
      })).min(1).max(500),
      fromPersonUuid: z.string(),
      // Tagged union so the server validates the three modes explicitly.
      to: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('person'), uuid: z.string() }),
        z.object({ kind: z.literal('unassign') }),
        z.object({ kind: z.literal('new') }),
      ]),
    }))
    .mutation(({ input, ctx }) => {
      const userDb = getUserSqlite();

      const from = userDb.prepare(
        'SELECT id FROM people WHERE uuid = ? AND user_id = ?',
      ).get(input.fromPersonUuid, ctx.userId) as { id: number } | undefined;
      if (!from) throw new Error('Source person not found');

      // Resolve target person_id (or null to unassign). For 'new' we
      // need a cover face — we pick the best face from the first item
      // that actually has one assigned to the source person, so an empty
      // 'new' cluster never gets created.
      let toPersonId: number | null = null;
      let createdPersonUuid: string | null = null;

      // Walk every item, collecting faces to reassign.
      type Pending = {
        workspaceSlug: string;
        faces: Array<{ id: number; confidence: number }>;
      };
      const pending: Pending[] = [];
      let firstCover: { faceId: number; workspaceSlug: string } | null = null;

      for (const item of input.items) {
        try {
          const ws = getRawSqlite(item.workspaceSlug);
          const row = ws.prepare(
            'SELECT id FROM media_items WHERE uuid = ? AND deleted_at IS NULL',
          ).get(item.itemUuid) as { id: number } | undefined;
          if (!row) continue;
          const faces = ws.prepare(`
            SELECT id, confidence FROM media_faces
            WHERE media_item_id = ? AND person_id = ?
            ORDER BY confidence DESC
          `).all(row.id, from.id) as Array<{ id: number; confidence: number }>;
          if (faces.length === 0) continue;
          pending.push({ workspaceSlug: item.workspaceSlug, faces });
          if (!firstCover) {
            firstCover = { faceId: faces[0].id, workspaceSlug: item.workspaceSlug };
          }
        } catch {
          // Workspace gone or unreadable — skip this item.
        }
      }

      if (pending.length === 0) {
        return { ok: true, movedFaces: 0, skipped: input.items.length, createdPersonUuid: null };
      }

      // Resolve target now that we know we have at least one face to move.
      if (input.to.kind === 'unassign') {
        toPersonId = null;
      } else if (input.to.kind === 'new') {
        const newUuid = crypto.randomUUID();
        const res = userDb.prepare(`
          INSERT INTO people (uuid, user_id, face_count, cover_face_id, cover_workspace_slug)
          VALUES (?, ?, 0, ?, ?)
          RETURNING id
        `).get(
          newUuid, ctx.userId,
          firstCover!.faceId, firstCover!.workspaceSlug,
        ) as { id: number };
        toPersonId = res.id;
        createdPersonUuid = newUuid;
      } else {
        if (input.to.uuid === input.fromPersonUuid) {
          return { ok: true, movedFaces: 0, skipped: 0, createdPersonUuid: null };
        }
        const to = userDb.prepare(
          'SELECT id FROM people WHERE uuid = ? AND user_id = ?',
        ).get(input.to.uuid, ctx.userId) as { id: number } | undefined;
        if (!to) throw new Error('Target person not found');
        toPersonId = to.id;
      }

      // Reassign. Cached statement per workspace so big batches don't
      // pay the prepare cost N times.
      const updateStmts = new Map<string, Statement>();
      const getUpd = (slug: string): Statement => {
        const existing = updateStmts.get(slug);
        if (existing) return existing;
        const stmt = getRawSqlite(slug).prepare(
          'UPDATE media_faces SET person_id = ? WHERE id = ?',
        );
        updateStmts.set(slug, stmt);
        return stmt;
      };
      let moved = 0;
      for (const p of pending) {
        const upd = getUpd(p.workspaceSlug);
        for (const f of p.faces) {
          upd.run(toPersonId, f.id);
          moved++;
        }
      }

      // Recompute face_count for source + target. Cross-workspace sum.
      const countFor = (pid: number): number => {
        let total = 0;
        for (const w of listWorkspaces()) {
          try {
            const c = getRawSqlite(w.slug).prepare(
              'SELECT COUNT(*) AS n FROM media_faces WHERE person_id = ?',
            ).get(pid) as { n: number };
            total += c.n;
          } catch { /* skip unreadable workspace */ }
        }
        return total;
      };

      const fromCount = countFor(from.id);
      if (fromCount === 0) {
        const info = userDb.prepare(
          'SELECT name FROM people WHERE id = ?',
        ).get(from.id) as { name: string | null };
        if (info.name === null) {
          userDb.prepare('DELETE FROM people WHERE id = ?').run(from.id);
        } else {
          userDb.prepare(
            'UPDATE people SET face_count = 0, updated_at = ? WHERE id = ?',
          ).run(Date.now(), from.id);
        }
      } else {
        userDb.prepare(
          'UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?',
        ).run(fromCount, Date.now(), from.id);
      }

      if (toPersonId !== null) {
        const toCount = countFor(toPersonId);
        userDb.prepare(
          'UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?',
        ).run(toCount, Date.now(), toPersonId);
      }

      return {
        ok: true,
        movedFaces: moved,
        skipped: input.items.length - pending.length,
        createdPersonUuid,
      };
    }),

  // ── Mark a cluster as garbage (false-positive detections, multi-person
  // mush). Faces lose their assignment but are NOT deleted — re-running
  // cluster-faces could re-cluster them. The people row is removed.
  delete: publicProcedure
    .input(z.object({ uuid: z.string() }))
    .mutation(({ input, ctx }) => {
      const db = getUserSqlite();
      const p = db.prepare(
        'SELECT id FROM people WHERE uuid = ? AND user_id = ?',
      ).get(input.uuid, ctx.userId) as { id: number } | undefined;
      if (!p) throw new Error('Person not found');

      for (const ws of listWorkspaces()) {
        getRawSqlite(ws.slug).prepare(
          'UPDATE media_faces SET person_id = NULL WHERE person_id = ?',
        ).run(p.id);
      }
      db.prepare('DELETE FROM people WHERE id = ?').run(p.id);
      return { ok: true };
    }),
});
