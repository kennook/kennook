import { z } from 'zod';
import { router, publicProcedure, adminProcedure } from '@/server/trpc';
import {
  getTenantOverrides,
  setTenantOverrides,
  getUserOverrides,
  setUserOverrides,
} from '@/server/shortcut-overrides';
import { publishToAll, publishToUser, bumpDataRev } from '@/server/sync-broker';

const entrySchema = z.object({
  keys: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
});
const mapSchema = z.record(z.string(), entrySchema);

/**
 * Tenant + user shortcut-override tiers. Both `get`s are public (every client
 * reads them to resolve bindings). `setTenant` is admin-only and instance-wide;
 * `setUser` is the signed-in user's own. Each write fans a `shortcuts.changed`
 * event so open windows/devices re-resolve; `setUser` also bumps the per-user
 * data-rev so the cross-process state poll converges other devices.
 */
export const shortcutsRouter = router({
  getTenant: publicProcedure.query(() => getTenantOverrides()),
  getUser: publicProcedure.query(({ ctx }) => getUserOverrides(ctx.userId)),

  setTenant: adminProcedure
    .input(mapSchema)
    .mutation(({ input, ctx }) => {
      setTenantOverrides(input);
      publishToAll({ sessionId: ctx.sessionId, event: { type: 'shortcuts.changed' } });
      return { ok: true };
    }),

  setUser: publicProcedure
    .input(mapSchema)
    .mutation(({ input, ctx }) => {
      setUserOverrides(ctx.userId, input);
      bumpDataRev(ctx.userId);
      publishToUser(ctx.userId, { sessionId: ctx.sessionId, event: { type: 'shortcuts.changed' } });
      return { ok: true };
    }),
});
