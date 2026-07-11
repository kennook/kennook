import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure } from '@/server/trpc';
import {
  listExternalSources,
  getExternalSource,
  addExternalSource,
  removeExternalSource,
} from '@/server/external-sources';
import { parseYouTubeUrl, resolveYouTubeSource, fetchPlaylistPage } from '@/server/youtube';

/**
 * External sources — YouTube channels/playlists surfaced alongside (but cleanly
 * separated from) the internal, indexed libraries. Videos are fetched live from
 * the provider; nothing is stored except the source's identity.
 */
export const externalSourceRouter = router({
  list: publicProcedure.query(() => listExternalSources()),

  get: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(({ input }) => getExternalSource(input.slug)),

  /** Create a source from a pasted YouTube channel/playlist URL. Resolves the
   *  canonical ids + title via the Data API before storing. */
  create: publicProcedure
    .input(z.object({ url: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const parsed = parseYouTubeUrl(input.url);
      if (!parsed) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Not a recognized YouTube channel or playlist URL.',
        });
      }
      let resolved;
      try {
        resolved = await resolveYouTubeSource(parsed);
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Failed to resolve source.' });
      }
      return addExternalSource({
        name: resolved.name,
        provider: 'youtube',
        kind: resolved.kind,
        ref: resolved.ref,
        playlistId: resolved.playlistId,
      });
    }),

  remove: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(({ input }) => { removeExternalSource(input.slug); return { ok: true }; }),

  /** A page of the source's videos — cursor is the YouTube page token, shaped
   *  for useInfiniteQuery (getNextPageParam → nextCursor). */
  items: publicProcedure
    .input(z.object({ slug: z.string(), cursor: z.string().optional() }))
    .query(async ({ input }) => {
      const src = getExternalSource(input.slug);
      if (!src) throw new TRPCError({ code: 'NOT_FOUND', message: 'Source not found.' });
      try {
        return await fetchPlaylistPage(src.playlistId, input.cursor);
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Failed to load videos.' });
      }
    }),
});
