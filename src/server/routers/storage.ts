import fs from 'node:fs';
import { z } from 'zod';
import { router, publicProcedure } from '@/server/trpc';
import { getRawSqlite } from '@/db/client';
import {
  createStorage,
  deleteStorage,
  listStorageInfo,
  updateStorageRoot,
  verifyRelocation,
} from '@/server/storage';

export const storageRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return listStorageInfo(getRawSqlite(ctx.library.slug));
  }),

  // Cheap existence/type probe for the AddStorage / Relocate dialog inputs.
  // Lets the UI validate paths before the user commits.
  testPath: publicProcedure
    .input(z.object({ path: z.string().min(1) }))
    .query(({ input }) => {
      const exists = fs.existsSync(input.path);
      const isDirectory = exists && fs.statSync(input.path).isDirectory();
      return { exists, isDirectory };
    }),

  add: publicProcedure
    .input(z.object({
      name: z.string().min(1).max(80),
      root_path: z.string().min(1),
    }))
    .mutation(({ ctx, input }) => {
      return createStorage(getRawSqlite(ctx.library.slug), input);
    }),

  remove: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => {
      deleteStorage(getRawSqlite(ctx.library.slug), input.id);
      return { ok: true as const };
    }),

  setRoot: publicProcedure
    .input(z.object({
      id: z.number().int().positive(),
      new_root_path: z.string().min(1),
    }))
    .mutation(({ ctx, input }) => {
      updateStorageRoot(getRawSqlite(ctx.library.slug), input.id, input.new_root_path);
      return { ok: true as const };
    }),

  // Dry-run for the Relocate flow: pick a sample of files from this storage
  // and verify they exist at the proposed new root. UI shows the result;
  // user confirms; UI then calls `setRoot` to commit.
  verifyRelocation: publicProcedure
    .input(z.object({
      id: z.number().int().positive(),
      new_root_path: z.string().min(1),
      sample_size: z.number().int().min(1).max(50).default(5),
    }))
    .query(({ ctx, input }) => {
      return verifyRelocation(
        getRawSqlite(ctx.library.slug),
        input.id,
        input.new_root_path,
        input.sample_size,
      );
    }),
});
