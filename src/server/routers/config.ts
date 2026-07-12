import { z } from 'zod';
import { router, publicProcedure, adminProcedure } from '@/server/trpc';
import { listConfig, setConfigValue } from '@/server/app-config';
import { THROTTLE_PRESETS, getThrottleLevel, setThrottleLevel } from '@/ai/throttle';
import { publishToAll } from '@/server/sync-broker';

const THROTTLE_LEVELS = ['full', 'light', 'background'] as const;

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
      // Instance config is global — every user's clients should refetch.
      publishToAll({
        sessionId: ctx.sessionId,
        event: { type: 'config.changed' },
      });
      return { ok: true };
    }),

  /** AI throttle: the presets (for the picker) + the current level. Public so
   *  the Jobs UI can render it without admin, though `setThrottle` is admin. */
  throttle: publicProcedure.query(() => ({
    level: getThrottleLevel(),
    presets: THROTTLE_LEVELS.map((l) => {
      const p = THROTTLE_PRESETS[l];
      return { level: p.level, label: p.label, hint: p.hint };
    }),
  })),

  setThrottle: adminProcedure
    .input(z.object({ level: z.enum(THROTTLE_LEVELS) }))
    .mutation(({ input, ctx }) => {
      setThrottleLevel(input.level);
      publishToAll({ sessionId: ctx.sessionId, event: { type: 'config.changed' } });
      return { ok: true };
    }),
});
