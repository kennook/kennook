import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure } from '@/server/trpc';
import {
  listExternalSources,
  getExternalSource,
  addExternalSource,
  removeExternalSource,
  reorderExternalSources,
  renameExternalSource,
} from '@/server/external-sources';
import { parseYouTubeUrl, resolveYouTubeSource, fetchPlaylistPage, fetchVideoAsItem } from '@/server/youtube';
import { publishToUser, bumpDataRev } from '@/server/sync-broker';

/** Notify this user's other windows/devices that a sidebar list changed —
 *  in-process/same-browser via the event, cross-process via the data rev. */
function notifySidebar(userId: number, sessionId: string | null) {
  publishToUser(userId, { sessionId, event: { type: 'data.changed' } });
  bumpDataRev(userId);
}

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
    .mutation(async ({ input, ctx }) => {
      const parsed = parseYouTubeUrl(input.url);
      if (!parsed) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Not a recognized YouTube URL. Paste a channel, playlist, or video link.',
        });
      }
      let resolved;
      try {
        resolved = await resolveYouTubeSource(parsed);
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Failed to resolve source.' });
      }
      const src = addExternalSource({
        name: resolved.name,
        provider: 'youtube',
        kind: resolved.kind,
        ref: resolved.ref,
        playlistId: resolved.playlistId,
      });
      notifySidebar(ctx.userId, ctx.sessionId);
      return src;
    }),

  remove: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(({ input, ctx }) => {
      removeExternalSource(input.slug);
      notifySidebar(ctx.userId, ctx.sessionId);
      return { ok: true };
    }),

  /** Persist a new display order for the sidebar list (drag-to-sort). */
  reorder: publicProcedure
    .input(z.object({ slugs: z.array(z.string()) }))
    .mutation(({ input, ctx }) => {
      const sources = reorderExternalSources(input.slugs);
      notifySidebar(ctx.userId, ctx.sessionId);
      return sources;
    }),

  /** Rename a source's display title. */
  rename: publicProcedure
    .input(z.object({ slug: z.string(), name: z.string().trim().min(1).max(120) }))
    .mutation(({ input, ctx }) => {
      const src = renameExternalSource(input.slug, input.name);
      if (!src) throw new TRPCError({ code: 'NOT_FOUND', message: 'Source not found.' });
      notifySidebar(ctx.userId, ctx.sessionId);
      return src;
    }),

  /** A page of the source's videos — cursor is the YouTube page token, shaped
   *  for useInfiniteQuery (getNextPageParam → nextCursor). */
  items: publicProcedure
    .input(z.object({ slug: z.string(), cursor: z.string().optional() }))
    .query(async ({ input }) => {
      const src = getExternalSource(input.slug);
      if (!src) throw new TRPCError({ code: 'NOT_FOUND', message: 'Source not found.' });
      try {
        // A single-video/live source is just its one video; channels/playlists page.
        if (src.kind === 'video') {
          return { items: [await fetchVideoAsItem(src.ref)], nextCursor: undefined as string | undefined };
        }
        return await fetchPlaylistPage(src.playlistId, input.cursor);
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Failed to load videos.' });
      }
    }),
});
