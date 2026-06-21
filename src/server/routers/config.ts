import { z } from 'zod';
import { router, publicProcedure, adminProcedure } from '@/server/trpc';
import { listConfig, setConfigValue } from '@/server/app-config';
import { publishToUser } from '@/server/sync-broker';

/**
 * Instance configuration. `list` is public (the app reads toggles like
 * `screensaver.enabled` to gate features); `set` is admin-only and fans out a
 * `config.changed` sync event so open clients pick the change up live.
 */
export const configRouter = router({
  list: publicProcedure.query(() => listConfig()),

  set: adminProcedure
    .input(z.object({ key: z.string(), value: z.boolean() }))
    .mutation(({ input, ctx }) => {
      setConfigValue(input.key, input.value); // throws on unknown key
      publishToUser(ctx.userId, {
        sessionId: ctx.sessionId,
        event: { type: 'config.changed' },
      });
      return { ok: true };
    }),
});
