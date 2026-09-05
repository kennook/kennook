import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, adminProcedure } from '@/server/trpc';
import {
  getPasscodeLength,
  isLockEnabled,
  lockModeFor,
  setLockPasscode,
  verifyLockInput,
} from '@/server/screensaver-lock';

/**
 * Screensaver lock API. `status`/`verify` are public — anyone (a Viewer)
 * needs to discover the lock and submit a credential to dismiss it.
 * `setPasscode` is admin-only so a Viewer can't disable or change the lock.
 * See `server/screensaver-lock.ts` for how the unlock mode is chosen.
 */
export const screensaverLockRouter = router({
  /**
   * Lock state for the CURRENT session. `enabled` is whether a passcode is
   * set at all; `mode` tells the client which credential to prompt for —
   * the account `'password'` for a signed-in named user, the numeric
   * `'passcode'` otherwise, or `'none'` when nothing is required.
   */
  status: publicProcedure.query(({ ctx }) => ({
    enabled: isLockEnabled(),
    mode: lockModeFor(ctx.userId),
    length: getPasscodeLength(),
  })),

  /** Check a dismiss attempt against whatever the session's mode requires.
   *  Returns `{ ok: true }` when no lock applies, so the client can dismiss
   *  uniformly. */
  verify: publicProcedure
    .input(z.object({ value: z.string() }))
    .mutation(({ ctx, input }) => ({ ok: verifyLockInput(ctx.userId, input.value) })),

  /** Set the numeric passcode, or clear it with an empty string. Rejects a
   *  non-numeric / too-short passcode. */
  setPasscode: adminProcedure
    .input(z.object({ passcode: z.string() }))
    .mutation(({ input }) => {
      try {
        setLockPasscode(input.passcode);
      } catch (e) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: e instanceof Error ? e.message : 'Could not set passcode',
        });
      }
      return { enabled: isLockEnabled() };
    }),
});
