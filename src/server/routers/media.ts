import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import { getRawSqlite } from '@/db/client';
import { getUserSqlite } from '@/db/user-client';
import { embedText, floatArrayToBuffer } from '@/ai/embeddings';
import type { Context } from '@/server/trpc';
import { publishToUser } from '@/server/sync-broker';
import { NSFW_THRESHOLD, VIOLENCE_THRESHOLD } from '@/lib/sensitive-thresholds';

interface MediaRow {
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

export const MAX_LIKES = 5;

// SQL fragment that computes the current user's like count for a given row.
// The single `?` placeholder is the user_id at bind time. Use whenever a
// query selects from media_items aliased as `m`. Exported so the playlist
// router (which reads cross-workspace items) can include the same field.
export const LIKE_COUNT_EXPR =
  'COALESCE((SELECT count FROM media_likes WHERE media_item_id = m.id AND user_id = ?), 0) AS like_count';

interface SearchRow extends MediaRow {
  vec_similarity: number;
  fts_score: number | null;
  final_score: number;
}

type SqlParam = string | number | null;

const orientationSchema = z.enum(['portrait', 'landscape', 'square']).optional();
const watchedSchema = z.enum(['watched', 'unwatched']).optional();

// Filters applicable to every view (list, search, similar). Kept as a single
// schema so the API is consistent and easy to extend.
const filterShape = z.object({
  kind: z.enum(['photo', 'video']).optional(),
  orientation: orientationSchema,
  cameraMake: z.string().optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  tags: z.array(z.string()).optional(),
  minLikes: z.number().int().min(1).max(MAX_LIKES).optional(),
  watched: watchedSchema,
  /** UUID of a person (from `people`) — limits results to items where at
   *  least one detected face belongs to this person. */
  person: z.string().optional(),
  /** Sensitive-content filter:
   *    'hide' → drop items where either NSFW or violence is above threshold;
   *    'only' → keep ONLY those items (review mode).
   *  Unset → no filter; flagged items still surface (with a badge). */
  sensitive: z.enum(['hide', 'only']).optional(),
});
export type MediaFilters = z.infer<typeof filterShape>;

// Records that the current user has interacted with the item — called from
// every place an interaction happens (open in viewer, like, tag, playlist
// add). Upsert so it's idempotent and the first viewed_at sticks.
function markViewed(
  sqlite: ReturnType<typeof getRawSqlite>,
  userId: number,
  mediaItemId: number,
) {
  sqlite.prepare(`
    INSERT INTO media_views (user_id, media_item_id, viewed_at)
    VALUES (?, ?, ?)
    ON CONFLICT (user_id, media_item_id) DO NOTHING
  `).run(userId, mediaItemId, Date.now());
}

// Exported so the playlist router can mark items viewed when they're added
// to a playlist (which counts as an interaction).
export function markItemViewedByUuid(
  workspaceSlug: string,
  userId: number,
  uuid: string,
) {
  const sqlite = getRawSqlite(workspaceSlug);
  const item = sqlite.prepare(
    'SELECT id FROM media_items WHERE uuid = ? AND deleted_at IS NULL',
  ).get(uuid) as { id: number } | undefined;
  if (!item) return;
  markViewed(sqlite, userId, item.id);
}

// ─── Filter SQL builder ───────────────────────────────────────────────────
//
// Builds a WHERE-clause body (without the leading `WHERE`) plus the matching
// parameter array. SQLite comparisons against NULL evaluate to NULL (≈ false
// in WHERE), so items missing width/height/camera_make naturally drop out of
// "portrait" or "iPhone" filters without explicit IS NOT NULL guards.

interface FilterClauses {
  where: string;
  params: SqlParam[];
}

function buildFilterClauses(filters: MediaFilters, ctx: Context): FilterClauses {
  const where: string[] = ['m.user_id = ?', 'm.deleted_at IS NULL'];
  const params: SqlParam[] = [ctx.userId];

  if (filters.kind) {
    where.push('m.kind = ?');
    params.push(filters.kind);
  }
  if (filters.orientation === 'portrait') where.push('m.height > m.width');
  else if (filters.orientation === 'landscape') where.push('m.width > m.height');
  else if (filters.orientation === 'square') where.push('m.width = m.height AND m.width > 0');

  if (filters.cameraMake) {
    where.push('m.camera_make = ?');
    params.push(filters.cameraMake);
  }
  if (filters.year != null) {
    where.push(`strftime('%Y', m.captured_at / 1000, 'unixepoch') = ?`);
    params.push(String(filters.year));
  }
  if (filters.tags && filters.tags.length > 0) {
    // Within-facet semantics: OR (user wants items with ANY of the selected
    // tags). Across-facet semantics: AND (other filters apply too).
    const placeholders = filters.tags.map(() => '?').join(',');
    where.push(`m.id IN (
      SELECT DISTINCT mt.media_item_id FROM media_tags mt
      JOIN tags t ON t.id = mt.tag_id
      WHERE t.name IN (${placeholders})
    )`);
    for (const t of filters.tags) params.push(t);
  }

  if (filters.minLikes != null) {
    // User-scoped: each user has their own likes. EXISTS subquery instead of
    // JOIN so we don't need to also alter SELECT/GROUP BY in callers.
    where.push(`EXISTS (
      SELECT 1 FROM media_likes ml
      WHERE ml.media_item_id = m.id
        AND ml.user_id = ?
        AND ml.count >= ?
    )`);
    params.push(ctx.userId, filters.minLikes);
  }

  if (filters.watched === 'watched') {
    where.push(`EXISTS (
      SELECT 1 FROM media_views mv
      WHERE mv.media_item_id = m.id AND mv.user_id = ?
    )`);
    params.push(ctx.userId);
  } else if (filters.watched === 'unwatched') {
    where.push(`NOT EXISTS (
      SELECT 1 FROM media_views mv
      WHERE mv.media_item_id = m.id AND mv.user_id = ?
    )`);
    params.push(ctx.userId);
  }

  if (filters.person) {
    // people lives in user.db, media_faces in workspace.db — so we
    // resolve the uuid → numeric id here (small lookup, one row) and
    // then constrain media_items via EXISTS on the local media_faces.
    const userDb = getUserSqlite();
    const p = userDb.prepare(
      'SELECT id FROM people WHERE uuid = ? AND user_id = ?',
    ).get(filters.person, ctx.userId) as { id: number } | undefined;
    if (p) {
      where.push(`EXISTS (
        SELECT 1 FROM media_faces mf
        WHERE mf.media_item_id = m.id AND mf.person_id = ?
      )`);
      params.push(p.id);
    } else {
      // Unknown person → force-empty result rather than ignoring the filter.
      where.push('1 = 0');
    }
  }

  if (filters.sensitive === 'hide') {
    where.push('(m.nsfw_score < ? AND m.violence_score < ?)');
    params.push(NSFW_THRESHOLD, VIOLENCE_THRESHOLD);
  } else if (filters.sensitive === 'only') {
    where.push('(m.nsfw_score >= ? OR m.violence_score >= ?)');
    params.push(NSFW_THRESHOLD, VIOLENCE_THRESHOLD);
  }

  return { where: where.join(' AND '), params };
}

// Strip one filter key — used for drill-down facets so that a facet's counts
// reflect the rest of the user's filters without filtering itself out.
function withoutKey(filters: MediaFilters, key: keyof MediaFilters): MediaFilters {
  return { ...filters, [key]: undefined };
}

// ─── Facets ───────────────────────────────────────────────────────────────

export interface FacetCounts {
  kinds: Array<{ value: 'photo' | 'video'; count: number }>;
  orientations: Array<{ value: 'portrait' | 'landscape' | 'square'; count: number }>;
  cameras: Array<{ value: string; count: number }>;
  years: Array<{ value: number; count: number }>;
  tags: Array<{ value: string; count: number }>;
}

interface FacetContext {
  /** Text query: facets reflect items closest to this query in CLIP space. */
  query?: string;
  /** Similar-mode source: facets reflect items closest to this item. */
  similarToUuid?: string;
}

/**
 * Get the candidate set of media_item IDs to aggregate facets over.
 *
 * - No context: null (aggregate over the whole filtered library)
 * - Query: top-500 vector matches to the query
 * - Similar: top-500 nearest neighbors of the source item (excluding source)
 *
 * Using 500 keeps us under SQLite's 999-parameter limit for IN clauses while
 * giving enough breadth for meaningful facet counts.
 */
async function getCandidateIds(
  sqlite: ReturnType<typeof getRawSqlite>,
  ctx: Context,
  opts: FacetContext,
): Promise<number[] | null> {
  if (opts.query) {
    const queryEmbed = await embedText(opts.query);
    const queryBuf = floatArrayToBuffer(queryEmbed);
    const rows = sqlite.prepare(`
      SELECT rowid AS id, distance FROM media_embeddings
      WHERE embedding MATCH ?
        AND k = 500
      ORDER BY distance
    `).all(queryBuf) as unknown as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }
  if (opts.similarToUuid) {
    const source = sqlite.prepare(`
      SELECT id FROM media_items WHERE uuid = ? AND user_id = ? AND deleted_at IS NULL
    `).get(opts.similarToUuid, ctx.userId) as { id: number } | undefined;
    if (!source) return [];
    const embRow = sqlite.prepare(
      'SELECT embedding FROM media_embeddings WHERE rowid = ?',
    ).get(BigInt(source.id)) as { embedding: Uint8Array } | undefined;
    if (!embRow) return [];
    const rows = sqlite.prepare(`
      SELECT rowid AS id, distance FROM media_embeddings
      WHERE embedding MATCH ?
        AND k = 501
      ORDER BY distance
    `).all(embRow.embedding) as unknown as Array<{ id: number }>;
    return rows.map((r) => r.id).filter((id) => id !== source.id);
  }
  return null;
}

async function computeFacets(
  filters: MediaFilters,
  ctx: Context,
  facetCtx: FacetContext,
): Promise<FacetCounts> {
  const sqlite = getRawSqlite(ctx.workspace.slug);

  // Candidate set narrows facet aggregation to "what's relevant right now".
  // null = no narrowing (recent mode); empty array = no matches at all.
  const candidateIds = await getCandidateIds(sqlite, ctx, facetCtx);

  const empty: FacetCounts = { kinds: [], orientations: [], cameras: [], years: [], tags: [] };
  if (candidateIds !== null && candidateIds.length === 0) return empty;

  // Build a candidate-membership clause + parameter array (or pass-through
  // when there's no context narrowing).
  const candidateClause = candidateIds === null
    ? ''
    : `AND m.id IN (${candidateIds.map(() => '?').join(',')})`;
  const candidateParams: SqlParam[] = candidateIds ?? [];

  // For each facet: filter clauses excluding this facet's own key + candidate
  // membership + group/order.
  const facet = (key: keyof MediaFilters) => {
    const f = buildFilterClauses(withoutKey(filters, key), ctx);
    return { where: f.where, params: [...f.params, ...candidateParams] };
  };

  const kf = facet('kind');
  const kinds = sqlite.prepare(`
    SELECT m.kind AS value, COUNT(*) AS count
    FROM media_items m
    WHERE ${kf.where} ${candidateClause}
    GROUP BY m.kind
    ORDER BY count DESC
  `).all(...kf.params) as unknown as FacetCounts['kinds'];

  const of_ = facet('orientation');
  const orientations = sqlite.prepare(`
    SELECT
      CASE
        WHEN m.height > m.width THEN 'portrait'
        WHEN m.width > m.height THEN 'landscape'
        WHEN m.width = m.height AND m.width > 0 THEN 'square'
        ELSE NULL
      END AS value,
      COUNT(*) AS count
    FROM media_items m
    WHERE ${of_.where} ${candidateClause}
    GROUP BY value
    HAVING value IS NOT NULL
    ORDER BY count DESC
  `).all(...of_.params) as unknown as FacetCounts['orientations'];

  const cf = facet('cameraMake');
  const cameras = sqlite.prepare(`
    SELECT m.camera_make AS value, COUNT(*) AS count
    FROM media_items m
    WHERE ${cf.where} AND m.camera_make IS NOT NULL ${candidateClause}
    GROUP BY m.camera_make
    ORDER BY count DESC, value ASC
    LIMIT 20
  `).all(...cf.params) as unknown as FacetCounts['cameras'];

  const yf = facet('year');
  const years = (sqlite.prepare(`
    SELECT strftime('%Y', m.captured_at / 1000, 'unixepoch') AS value, COUNT(*) AS count
    FROM media_items m
    WHERE ${yf.where} AND m.captured_at IS NOT NULL ${candidateClause}
    GROUP BY value
    ORDER BY value DESC
    LIMIT 15
  `).all(...yf.params) as unknown as Array<{ value: string; count: number }>)
    .map((r) => ({ value: parseInt(r.value, 10), count: r.count }));

  const tf = facet('tags');
  const tags = sqlite.prepare(`
    SELECT t.name AS value, COUNT(DISTINCT m.id) AS count
    FROM media_items m
    JOIN media_tags mt ON mt.media_item_id = m.id
    JOIN tags t ON t.id = mt.tag_id
    WHERE ${tf.where} ${candidateClause}
    GROUP BY t.id
    ORDER BY count DESC, value ASC
    LIMIT 30
  `).all(...tf.params) as unknown as FacetCounts['tags'];

  return { kinds, orientations, cameras, years, tags };
}

// ─── Router ───────────────────────────────────────────────────────────────

export const mediaRouter = router({
  list: publicProcedure
    .input(z.object({
      limit: z.number().min(1).max(200).default(60),
      offset: z.number().min(0).default(0),
      // Cursor is the path used by useInfiniteQuery on mobile. When set, it
      // overrides `offset`. Desktop pagination still uses `offset`; both
      // shapes coexist so we didn't have to fork the endpoint.
      cursor: z.number().min(0).optional(),
      ...filterShape.shape,
    }))
    .query(({ input, ctx }) => {
      const sqlite = getRawSqlite(ctx.workspace.slug);
      const { where, params } = buildFilterClauses(input, ctx);
      const effectiveOffset = input.cursor ?? input.offset;
      // Fetch limit+1 to detect a next page without a separate COUNT(*).
      const rows = sqlite.prepare(`
        SELECT m.id, m.uuid, m.filename, m.kind, m.width, m.height, m.duration_ms,
               m.captured_at, m.captured_place, m.camera_make, m.camera_model,
               m.size_bytes, m.path, m.rotation, m.nsfw_score, m.violence_score,
               ${LIKE_COUNT_EXPR}
        FROM media_items m
        WHERE ${where}
        ORDER BY COALESCE(m.captured_at, m.created_at) DESC
        LIMIT ? OFFSET ?
      `).all(ctx.userId, ...params, input.limit + 1, effectiveOffset) as unknown as MediaRow[];
      const hasMore = rows.length > input.limit;
      return {
        items: rows.slice(0, input.limit).map((r) => rowToDto(r, ctx.workspace.slug)),
        hasMore,
        nextCursor: hasMore ? effectiveOffset + input.limit : undefined,
      };
    }),

  get: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(({ input, ctx }) => {
      const sqlite = getRawSqlite(ctx.workspace.slug);
      const row = sqlite.prepare(`
        SELECT m.id, m.uuid, m.filename, m.kind, m.width, m.height, m.duration_ms,
               m.captured_at, m.captured_place, m.camera_make, m.camera_model,
               m.size_bytes, m.path, m.rotation, m.nsfw_score, m.violence_score,
               ${LIKE_COUNT_EXPR}
        FROM media_items m
        WHERE m.id = ? AND m.user_id = ? AND m.deleted_at IS NULL
      `).get(ctx.userId, input.id, ctx.userId) as unknown as MediaRow | undefined;
      if (!row) throw new Error('Not found');
      return rowToDto(row, ctx.workspace.slug);
    }),

  // Lazy-fetched item details — caption, OCR, tags, transcript, statuses.
  // Used by the viewer to surface AI-extracted metadata + debug fields for
  // verifying search relevance. Cross-workspace aware: pass workspaceSlug
  // explicitly (e.g. for items shown in a multi-workspace playlist).
  getDetails: publicProcedure
    .input(z.object({
      uuid: z.string(),
      workspaceSlug: z.string().optional(),
    }))
    .query(({ input, ctx }) => {
      const slug = input.workspaceSlug ?? ctx.workspace.slug;
      const sqlite = getRawSqlite(slug);
      const row = sqlite.prepare(`
        SELECT id, uuid, sha256, ai_caption, ai_summary, ocr_text, transcript,
               enrichment_status, embedding_status
        FROM media_items
        WHERE uuid = ? AND deleted_at IS NULL
      `).get(input.uuid) as {
        id: number;
        uuid: string;
        sha256: string | null;
        ai_caption: string | null;
        ai_summary: string | null;
        ocr_text: string | null;
        transcript: string | null;
        enrichment_status: string;
        embedding_status: string;
      } | undefined;
      if (!row) throw new Error('Not found');

      const tagRows = sqlite.prepare(`
        SELECT t.name, mt.confidence, mt.source
        FROM media_tags mt
        JOIN tags t ON t.id = mt.tag_id
        WHERE mt.media_item_id = ?
        ORDER BY mt.source DESC, t.name
      `).all(row.id) as Array<{ name: string; confidence: number | null; source: string }>;

      return {
        uuid: row.uuid,
        workspaceSlug: slug,
        sha256: row.sha256,
        aiCaption: row.ai_caption,
        aiSummary: row.ai_summary,
        ocrText: row.ocr_text,
        transcript: row.transcript,
        enrichmentStatus: row.enrichment_status,
        embeddingStatus: row.embedding_status,
        tags: tagRows,
      };
    }),

  similar: publicProcedure
    .input(z.object({
      uuid: z.string(),
      limit: z.number().min(1).max(100).default(60),
      offset: z.number().min(0).default(0),
      cursor: z.number().min(0).optional(),
      ...filterShape.shape,
    }))
    .query(({ input, ctx }) => {
      const sqlite = getRawSqlite(ctx.workspace.slug);

      const source = sqlite.prepare(`
        SELECT m.id, m.uuid, m.filename, m.kind, m.width, m.height, m.duration_ms,
               m.captured_at, m.captured_place, m.camera_make, m.camera_model,
               m.size_bytes, m.path, m.rotation, m.nsfw_score, m.violence_score,
               ${LIKE_COUNT_EXPR}
        FROM media_items m
        WHERE m.uuid = ? AND m.user_id = ? AND m.deleted_at IS NULL
      `).get(ctx.userId, input.uuid, ctx.userId) as unknown as MediaRow | undefined;

      if (!source) throw new Error('Source item not found');

      const embRow = sqlite.prepare(
        'SELECT embedding FROM media_embeddings WHERE rowid = ?',
      ).get(BigInt(source.id)) as { embedding: Uint8Array } | undefined;

      if (!embRow) return {
        source: rowToDto(source, ctx.workspace.slug),
        items: [],
        hasMore: false,
      };

      // Apply structural filters on the joined media_items row. The vector
      // KNN already operates on the full embedding table, then the structural
      // WHERE narrows results.
      const { where, params } = buildFilterClauses(input, ctx);

      const effectiveOffset = input.cursor ?? input.offset;
      // Use offset+limit+1 to support pagination + hasMore detection. k is
      // tuned to comfortably exceed any reasonable offset+limit so vector
      // results don't run out before pagination does.
      const k = Math.max(500, effectiveOffset + input.limit + 2);
      const rows = sqlite.prepare(`
        WITH vec_results AS (
          SELECT rowid AS id,
                 distance,
                 MAX(0.0, 1.0 - (distance * distance) / 2.0) AS vec_similarity
          FROM media_embeddings
          WHERE embedding MATCH ?
            AND k = ?
          ORDER BY distance
        )
        SELECT
          m.id, m.uuid, m.filename, m.kind, m.width, m.height, m.duration_ms,
          m.captured_at, m.captured_place, m.camera_make, m.camera_model,
          m.size_bytes, m.path, m.rotation, m.nsfw_score, m.violence_score,
          ${LIKE_COUNT_EXPR},
          v.vec_similarity AS vec_similarity,
          CAST(NULL AS REAL) AS fts_score,
          v.vec_similarity AS final_score
        FROM vec_results v
        JOIN media_items m ON m.id = v.id
        WHERE ${where} AND m.id != ?
        ORDER BY v.vec_similarity DESC
        LIMIT ? OFFSET ?
      `).all(
        embRow.embedding, k,
        ctx.userId,           // for LIKE_COUNT_EXPR in SELECT
        ...params,            // filter params (incl. minLikes if set)
        source.id,
        input.limit + 1, effectiveOffset,
      ) as unknown as SearchRow[];

      const hasMore = rows.length > input.limit;
      return {
        source: rowToDto(source, ctx.workspace.slug),
        items: rows.slice(0, input.limit).map((r) => ({
          ...rowToDto(r, ctx.workspace.slug),
          scores: { vector: r.vec_similarity, fts: r.fts_score, final: r.final_score },
        })),
        hasMore,
        nextCursor: hasMore ? effectiveOffset + input.limit : undefined,
      };
    }),

  search: publicProcedure
    .input(z.object({
      query: z.string().min(1).max(500),
      limit: z.number().min(1).max(100).default(60),
      offset: z.number().min(0).default(0),
      cursor: z.number().min(0).optional(),
      ...filterShape.shape,
    }))
    .query(async ({ input, ctx }) => {
      const sqlite = getRawSqlite(ctx.workspace.slug);
      const queryEmbed = await embedText(input.query);
      const queryBuf = floatArrayToBuffer(queryEmbed);
      const ftsQuery = toFtsQuery(input.query);

      const { where, params } = buildFilterClauses(input, ctx);

      const effectiveOffset = input.cursor ?? input.offset;
      // k must exceed offset+limit so pagination doesn't outrun the vector
      // candidate set. Default 500 is comfortable for typical browsing.
      const k = Math.max(500, effectiveOffset + input.limit + 2);
      const stmt = sqlite.prepare(`
        WITH vec_results AS (
          SELECT rowid AS id,
                 distance,
                 MAX(0.0, 1.0 - (distance * distance) / 2.0) AS vec_similarity
          FROM media_embeddings
          WHERE embedding MATCH ?
            AND k = ?
          ORDER BY distance
        ),
        fts_results AS (
          SELECT rowid AS id, bm25(media_fts) AS score
          FROM media_fts
          WHERE media_fts MATCH ?
        )
        SELECT
          m.id, m.uuid, m.filename, m.kind, m.width, m.height, m.duration_ms,
          m.captured_at, m.captured_place, m.camera_make, m.camera_model,
          m.size_bytes, m.path, m.rotation, m.nsfw_score, m.violence_score,
          ${LIKE_COUNT_EXPR},
          v.vec_similarity AS vec_similarity,
          f.score          AS fts_score,
          (
            v.vec_similarity * 0.7 +
            (1.0 / (1.0 + COALESCE(f.score, 99))) * 0.3
          ) AS final_score
        FROM vec_results v
        JOIN media_items m ON m.id = v.id
        LEFT JOIN fts_results f ON f.id = v.id
        WHERE ${where}
        ORDER BY final_score DESC
        LIMIT ? OFFSET ?
      `);

      const rows = stmt.all(
        queryBuf, k, ftsQuery,
        ctx.userId,           // for LIKE_COUNT_EXPR in SELECT
        ...params,            // filter params (incl. minLikes if set)
        input.limit + 1, effectiveOffset,
      ) as unknown as SearchRow[];

      const hasMore = rows.length > input.limit;
      return {
        items: rows.slice(0, input.limit).map((r) => ({
          ...rowToDto(r, ctx.workspace.slug),
          scores: { vector: r.vec_similarity, fts: r.fts_score, final: r.final_score },
        })),
        hasMore,
        nextCursor: hasMore ? effectiveOffset + input.limit : undefined,
      };
    }),

  // Records that the user has interacted with the item. Fired from the
  // client whenever the viewer opens. Idempotent — repeat calls keep the
  // original viewed_at. Server-side mutations (like, tag, playlist add) call
  // the same helper internally so any interaction counts.
  markViewed: publicProcedure
    .input(z.object({
      uuid: z.string(),
      workspaceSlug: z.string().optional(),
    }))
    .mutation(({ input, ctx }) => {
      const slug = input.workspaceSlug ?? ctx.workspace.slug;
      const sqlite = getRawSqlite(slug);
      const item = sqlite.prepare(
        'SELECT id FROM media_items WHERE uuid = ? AND deleted_at IS NULL',
      ).get(input.uuid) as { id: number } | undefined;
      if (!item) throw new Error('Item not found');
      markViewed(sqlite, ctx.userId, item.id);
      return { uuid: input.uuid };
    }),

  // Set the like count on an item. The client passes the desired count (the
  // increment-then-wrap logic lives in the UI so the heart button feels
  // instant). Cross-workspace aware via optional workspaceSlug.
  setLike: publicProcedure
    .input(z.object({
      uuid: z.string(),
      count: z.number().int().min(0).max(MAX_LIKES),
      workspaceSlug: z.string().optional(),
    }))
    .mutation(({ input, ctx }) => {
      const slug = input.workspaceSlug ?? ctx.workspace.slug;
      const sqlite = getRawSqlite(slug);

      const item = sqlite.prepare(
        'SELECT id FROM media_items WHERE uuid = ? AND deleted_at IS NULL',
      ).get(input.uuid) as { id: number } | undefined;
      if (!item) throw new Error('Item not found');

      if (input.count === 0) {
        // No "0 likes" rows — delete instead so the table stays clean.
        sqlite.prepare(
          'DELETE FROM media_likes WHERE user_id = ? AND media_item_id = ?',
        ).run(ctx.userId, item.id);
      } else {
        sqlite.prepare(`
          INSERT INTO media_likes (user_id, media_item_id, count, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id, media_item_id) DO UPDATE
            SET count = excluded.count, updated_at = excluded.updated_at
        `).run(ctx.userId, item.id, input.count, Date.now());
      }
      // Liking counts as an interaction.
      markViewed(sqlite, ctx.userId, item.id);
      // Fan out to the user's other sessions so they update their caches
      // without a refetch. Originating tab skips this on receipt via the
      // session id stamped on the envelope.
      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: {
          type: 'item.like',
          workspaceSlug: slug,
          uuid: input.uuid,
          count: input.count,
        },
      });
      return { uuid: input.uuid, count: input.count };
    }),

  // Set the client-applied rotation override for a photo. Stored as
  // degrees (must be 0/90/180/270). EXIF-based orientation is already
  // applied at indexer time; this is the user's *additional* correction
  // for photos that still come out sideways. File contents aren't
  // modified — the rotation is just a flag the client uses to apply a
  // CSS transform at render time.
  setRotation: publicProcedure
    .input(z.object({
      uuid: z.string(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      workspaceSlug: z.string().optional(),
    }))
    .mutation(({ input, ctx }) => {
      const slug = input.workspaceSlug ?? ctx.workspace.slug;
      const sqlite = getRawSqlite(slug);
      const item = sqlite.prepare(
        'SELECT id FROM media_items WHERE uuid = ? AND deleted_at IS NULL',
      ).get(input.uuid) as { id: number } | undefined;
      if (!item) throw new Error('Item not found');
      sqlite.prepare(
        'UPDATE media_items SET rotation = ?, updated_at = ? WHERE id = ?',
      ).run(input.rotation, Date.now(), item.id);

      // Cross-session fanout: other tabs/devices patch their caches with
      // the new rotation. Originating tab skips via the session id.
      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: {
          type: 'item.rotation',
          workspaceSlug: slug,
          uuid: input.uuid,
          rotation: input.rotation,
        },
      });
      return { uuid: input.uuid, rotation: input.rotation };
    }),

  // Add a user-typed tag to a media item. Tag name is normalized to lowercase
  // + trimmed so "Beach", "beach ", "BEACH" all canonicalize. Reuses an
  // existing tag row if name already exists in this workspace; the link is
  // marked source='user' so re-enrichment doesn't replace it.
  addUserTag: publicProcedure
    .input(z.object({
      uuid: z.string(),
      name: z.string().min(1).max(60),
      workspaceSlug: z.string().optional(),
    }))
    .mutation(({ input, ctx }) => {
      const slug = input.workspaceSlug ?? ctx.workspace.slug;
      const sqlite = getRawSqlite(slug);

      const normalized = input.name.trim().toLowerCase();
      if (!normalized) throw new Error('Tag name is empty');

      const item = sqlite.prepare(
        'SELECT id FROM media_items WHERE uuid = ? AND deleted_at IS NULL',
      ).get(input.uuid) as { id: number } | undefined;
      if (!item) throw new Error('Item not found');

      // Find-or-create the tag row. Using INSERT...ON CONFLICT returns the id
      // either way (RETURNING works for both inserts and updates in SQLite).
      const tagRow = sqlite.prepare(`
        INSERT INTO tags (user_id, name, source) VALUES (1, ?, 'user')
        ON CONFLICT(user_id, name) DO UPDATE SET name = excluded.name
        RETURNING id
      `).get(normalized) as { id: number };

      // Upsert the link. If an auto link already exists, promote to user.
      sqlite.prepare(`
        INSERT INTO media_tags (media_item_id, tag_id, confidence, source)
        VALUES (?, ?, NULL, 'user')
        ON CONFLICT(media_item_id, tag_id) DO UPDATE SET source = 'user'
      `).run(item.id, BigInt(tagRow.id));

      // Tagging counts as an interaction.
      markViewed(sqlite, ctx.userId, item.id);

      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: { type: 'item.tag.changed', workspaceSlug: slug, uuid: input.uuid },
      });

      return { uuid: input.uuid, tag: normalized };
    }),

  // Remove a tag from a media item. Refuses to remove auto-tags so users
  // don't accidentally delete enrichment output (which would just come back
  // on next enrich run anyway).
  removeUserTag: publicProcedure
    .input(z.object({
      uuid: z.string(),
      name: z.string(),
      workspaceSlug: z.string().optional(),
    }))
    .mutation(({ input, ctx }) => {
      const slug = input.workspaceSlug ?? ctx.workspace.slug;
      const sqlite = getRawSqlite(slug);
      const normalized = input.name.trim().toLowerCase();

      sqlite.prepare(`
        DELETE FROM media_tags
        WHERE media_item_id = (SELECT id FROM media_items WHERE uuid = ?)
          AND tag_id = (SELECT id FROM tags WHERE user_id = 1 AND name = ?)
          AND source = 'user'
      `).run(input.uuid, normalized);

      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: { type: 'item.tag.changed', workspaceSlug: slug, uuid: input.uuid },
      });

      return { uuid: input.uuid, tag: normalized };
    }),

  // Drill-down facet aggregation for the current view + filter state.
  //
  // - Recent mode (no query/similarToUuid): aggregates over the filtered
  //   library — counts reflect the whole workspace's items matching filters.
  // - Search mode (query set): aggregates over the top-500 vector matches —
  //   counts reflect "what's similar to your query."
  // - Similar mode (similarToUuid set): aggregates over the top-500 nearest
  //   neighbors of the source item.
  //
  // In all cases, each individual facet's counts EXCLUDE its own active
  // filter (drill-down behavior), so users can see what they'd get by
  // switching options.
  facets: publicProcedure
    .input(z.object({
      ...filterShape.shape,
      query: z.string().optional(),
      similarToUuid: z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const { query, similarToUuid, ...filters } = input;
      return computeFacets(filters, ctx, { query, similarToUuid });
    }),
});

// Includes the workspace slug + bakes it into media URLs so cross-workspace
// rendering (e.g. playlists) works without depending on the active cookie.
function rowToDto(row: MediaRow, workspaceSlug: string) {
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
    rotation: row.rotation,
    nsfwScore: row.nsfw_score,
    violenceScore: row.violence_score,
    workspaceSlug,
    thumbnailUrl: `/api/thumbnails/${row.uuid}${qs}`,
    previewUrl: `/api/preview/${row.uuid}${qs}`,
    mediaUrl: `/api/media/${row.uuid}${qs}`,
  };
}

function toFtsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return '""';
  return tokens.map((t) => `${t}*`).join(' OR ');
}
