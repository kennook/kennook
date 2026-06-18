import { z } from 'zod';
import { router, publicProcedure, adminProcedure } from '@/server/trpc';
import {
  isLockEnabled,
  setLockPassword,
  verifyLockPassword,
} from '@/server/screensaver-lock';

/**
 * Screensaver lock API. `status`/`verify` are public — anyone (a Viewer)
 * needs to be able to discover the lock and submit the passphrase to dismiss
 * it. `setPassword` is admin-only so a Viewer can't disable or change the
 * lock. See `server/screensaver-lock.ts` for the (deliberately modest)
 * threat model.
 */
export const screensaverLockRouter = router({
  /** Is a passphrase currently required to dismiss the screensaver? */
  status: publicProcedure.query(() => ({ enabled: isLockEnabled() })),

  /** Check a candidate passphrase. Returns `{ ok: true }` when there is no
   *  lock set, so the client can dismiss uniformly. */
  verify: publicProcedure
    .input(z.object({ password: z.string() }))
    .mutation(({ input }) => ({ ok: verifyLockPassword(input.password) })),

  /** Set the passphrase, or clear it by passing an empty string. */
  setPassword: adminProcedure
    .input(z.object({ password: z.string() }))
    .mutation(({ input }) => {
      setLockPassword(input.password);
      return { enabled: isLockEnabled() };
    }),
});
