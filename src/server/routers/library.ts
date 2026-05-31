import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import {
  createLibrary,
  listLibraries,
} from '@/server/libraries';

export const libraryRouter = router({
  // All libraries in the registry.
  list: publicProcedure.query(() => listLibraries()),

  // Library currently bound to this request (resolved from cookie).
  current: publicProcedure.query(({ ctx }) => ctx.library),

  // Create a new library. Slug auto-derived from name. Requires an
  // initial root_path — every library must point at at least one
  // folder; we don't auto-pick "/" for the user.
  create: publicProcedure
    .input(z.object({
      name: z.string().min(1).max(80),
      root_path: z.string().min(1),
      storage_name: z.string().min(1).max(80).optional(),
    }))
    .mutation(({ input }) => createLibrary(input)),
});
