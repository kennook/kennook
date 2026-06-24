import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '@/server/trpc';
import { listLoginUsers, setUserPassword, createUser, deleteUser } from '@/server/auth';

/**
 * Admin-only user management. Every procedure is `adminProcedure` — gated on a
 * signed admin session.
 */
export const usersRouter = router({
  list: adminProcedure.query(() => listLoginUsers()),

  /** Create a named account (admin path; self-signup uses /api/auth/signup). */
  create: adminProcedure
    .input(z.object({
      name: z.string().min(1),
      password: z.string().min(1),
      role: z.enum(['viewer', 'admin']).default('viewer'),
    }))
    .mutation(({ input }) => {
      try {
        return createUser(input.name, input.password, input.role);
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Could not create user' });
      }
    }),

  /** Delete a user (the built-in Viewer/Admin are protected). */
  delete: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(({ input }) => {
      try {
        deleteUser(input.userId);
        return { ok: true };
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Could not delete user' });
      }
    }),

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
