import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import { getHotCorners, setHotCorners } from '@/server/hot-corners';
import { HOT_CORNER_ACTIONS } from '@/lib/hot-corner';
import { publishToUser } from '@/server/sync-broker';

const actionEnum = z.enum(HOT_CORNER_ACTIONS);
const mapSchema = z.object({
  topLeft: actionEnum,
  topRight: actionEnum,
  bottomLeft: actionEnum,
  bottomRight: actionEnum,
});

/**
 * Per-user hot-corner mapping. `get` is public (the app reads it to run the
 * corner engine + the viewer's fade predicate); `set` persists the full map and
 * fans a `config.changed` event to this user's other windows/devices so they
 * refetch.
 */
export const hotCornersRouter = router({
  get: publicProcedure.query(({ ctx }) => getHotCorners(ctx.userId)),

  set: publicProcedure
    .input(mapSchema)
    .mutation(({ input, ctx }) => {
      setHotCorners(ctx.userId, input);
      publishToUser(ctx.userId, { sessionId: ctx.sessionId, event: { type: 'config.changed' } });
      return { ok: true };
    }),
});
