import { z } from 'zod';
import { router, adminProcedure } from '@/server/trpc';
import { listLoginUsers, setUserPassword } from '@/server/auth';

/**
 * Admin-only user management. Today just login passwords; create/rename/
 * delete land here later. Every procedure is `adminProcedure` — gated on a
 * signed admin session.
 */
export const usersRouter = router({
  list: adminProcedure.query(() => listLoginUsers()),

  /** Set (non-empty) or clear (empty string) a user's login password. */
  setPassword: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      password: z.string(),
    }))
    .mutation(({ input }) => {
      setUserPassword(input.userId, input.password);
      return { ok: true };
    }),
});
