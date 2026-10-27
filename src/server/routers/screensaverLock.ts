import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, adminProcedure } from '@/server/trpc';
import {
  getLockSecretType,
  getPasscodeLength,
  isLockEnabled,
  lockModeFor,
  setLockSecret,
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
    // The shared secret's kind — tells the client whether the anonymous/kiosk
    // unlock prompt should be numeric PIN boxes or a password field. Only
    // meaningful when `mode` is 'passcode' (the shared-secret path).
    secretType: getLockSecretType(),
  })),

  /** Check a dismiss attempt against whatever the session's mode requires.
   *  Returns `{ ok: true }` when no lock applies, so the client can dismiss
   *  uniformly. */
  verify: publicProcedure
    .input(z.object({ value: z.string() }))
    .mutation(({ ctx, input }) => ({ ok: verifyLockInput(ctx.userId, input.value) })),

  /** Set the shared secret — a numeric `passcode` or a free-form `password` —
   *  or clear the lock with an empty value. Rejects an invalid value for the
   *  chosen type. */
  setSecret: adminProcedure
    .input(z.object({
      type: z.enum(['passcode', 'password']),
      value: z.string(),
    }))
    .mutation(({ input }) => {
      try {
        setLockSecret(input.type, input.value);
      } catch (e) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: e instanceof Error ? e.message : 'Could not set the lock',
        });
      }
      return { enabled: isLockEnabled() };
    }),
});
