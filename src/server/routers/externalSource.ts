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
  setExternalSourceCategory,
  moveExternalSource,
  renameExternalCategory,
  deleteExternalCategory,
} from '@/server/external-sources';
import { detectProvider, getProvider, listProviders } from '@/server/providers/registry';
import type { ProviderVideo } from '@/server/providers/types';
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

  /** Providers available for the add dialog (id + label + example URL). */
  providers: publicProcedure.query(() => listProviders()),

  /** Create a source from a pasted URL. The provider is auto-detected (or forced
   *  via `provider`); it resolves the canonical ids + title before storing. */
  create: publicProcedure
    .input(z.object({
      url: z.string().min(1),
      /** Optional override when auto-detect is ambiguous (e.g. a bare media URL). */
      provider: z.string().optional(),
      /** Display name — required for sources with no fetchable title (raw streams). */
      name: z.string().trim().max(120).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const provider = input.provider ? getProvider(input.provider) : detectProvider(input.url);
      if (!provider) {
        const hints = listProviders().map((p) => p.label).join(', ');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Couldn't recognize that URL. Supported: ${hints}.`,
        });
      }
      let resolved;
      try {
        resolved = await provider.resolve(input.url, { name: input.name });
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Failed to resolve source.' });
      }
      const src = addExternalSource({
        name: resolved.name,
        provider: provider.id,
        kind: resolved.kind,
        ref: resolved.ref,
        playlistId: resolved.playlistId,
        playerKind: resolved.playerKind,
        ...(resolved.meta ? { meta: resolved.meta } : {}),
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

  /** Assign a source to a category (or clear it with an empty string). */
  setCategory: publicProcedure
    .input(z.object({ slug: z.string(), category: z.string().trim().max(60) }))
    .mutation(({ input, ctx }) => {
      const src = setExternalSourceCategory(input.slug, input.category);
      if (!src) throw new TRPCError({ code: 'NOT_FOUND', message: 'Source not found.' });
      notifySidebar(ctx.userId, ctx.sessionId);
      return src;
    }),

  /** Drag/drop move in the tree: set a source's category + reposition it before
   *  `beforeSlug` (null = end). One atomic write. */
  move: publicProcedure
    .input(z.object({
      slug: z.string(),
      category: z.string().trim().max(60).nullable(),
      beforeSlug: z.string().nullable(),
    }))
    .mutation(({ input, ctx }) => {
      const sources = moveExternalSource(input.slug, input.category, input.beforeSlug);
      notifySidebar(ctx.userId, ctx.sessionId);
      return sources;
    }),

  /** Rename a category everywhere it's used. */
  renameCategory: publicProcedure
    .input(z.object({ from: z.string(), to: z.string().trim().min(1).max(60) }))
    .mutation(({ input, ctx }) => {
      const sources = renameExternalCategory(input.from, input.to);
      notifySidebar(ctx.userId, ctx.sessionId);
      return sources;
    }),

  /** Delete a category — its sources become uncategorized. */
  deleteCategory: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(({ input, ctx }) => {
      const sources = deleteExternalCategory(input.name);
      notifySidebar(ctx.userId, ctx.sessionId);
      return sources;
    }),

  /** One video per single-video/live source in a category — the grid for that
   *  group. Fetched in parallel; a source that fails to resolve is skipped so a
   *  single dead stream doesn't blank the whole category. */
  categoryItems: publicProcedure
    .input(z.object({ category: z.string() }))
    .query(async ({ input }) => {
      const cat = input.category.trim().toLowerCase();
      const sources = listExternalSources().filter(
        (s) => s.kind === 'video' && (s.category ?? '').toLowerCase() === cat,
      );
      const settled = await Promise.allSettled(
        sources.map(async (s) => ({ slug: s.slug, video: await getProvider(s.provider).fetchVideo(s) })),
      );
      const items = settled
        .filter((r): r is PromiseFulfilledResult<{ slug: string; video: ProviderVideo }> => r.status === 'fulfilled')
        .map((r) => r.value);
      return { items };
    }),

  /** A page of the source's videos — cursor is the YouTube page token, shaped
   *  for useInfiniteQuery (getNextPageParam → nextCursor). */
  items: publicProcedure
    .input(z.object({ slug: z.string(), cursor: z.string().optional(), filter: z.string().optional() }))
    .query(async ({ input }) => {
      const src = getExternalSource(input.slug);
      if (!src) throw new TRPCError({ code: 'NOT_FOUND', message: 'Source not found.' });
      const provider = getProvider(src.provider);
      try {
        // A single-video/live source is just its one item; channels/playlists/feeds page.
        if (src.kind === 'video') {
          return { items: [await provider.fetchVideo(src)], nextCursor: undefined as string | undefined };
        }
        // `filter` is honored by providers that can search their full set (M3U);
        // others ignore it and the client filters loaded items.
        return await provider.fetchPage(src, input.cursor, input.filter);
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Failed to load videos.' });
      }
    }),
});
