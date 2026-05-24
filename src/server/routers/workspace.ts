import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import {
  createWorkspace,
  listWorkspaces,
} from '@/server/workspaces';

export const workspaceRouter = router({
  // All workspaces in the registry.
  list: publicProcedure.query(() => listWorkspaces()),

  // Workspace currently bound to this request (resolved from cookie).
  current: publicProcedure.query(({ ctx }) => ctx.workspace),

  // Create a new workspace. Slug auto-derived from name.
  create: publicProcedure
    .input(z.object({ name: z.string().min(1).max(80) }))
    .mutation(({ input }) => createWorkspace(input.name)),
});
