import { router, publicProcedure } from '@/server/trpc';
import { KENNOOK_VERSION, KENNOOK_BUILD_ID } from '@/lib/version';
import { checkForUpdate, getPendingRestartVersion } from '@/server/system/update';

/**
 * System/version info. Read-only and harmless to expose (single-user v0.1,
 * same `publicProcedure` convention as the other routers); the admin pages
 * that consume it are gated at the layout. The actual upgrade runs through the
 * existing requireAdmin-gated POST /api/admin/jobs route.
 */
export const systemRouter = router({
  /** The build this process is running (baked at build time). */
  version: publicProcedure.query(() => ({
    version: KENNOOK_VERSION,
    buildId: KENNOOK_BUILD_ID,
  })),

  /** Compare the running build against the published manifest. */
  checkForUpdate: publicProcedure.query(() => checkForUpdate()),

  /** A version that's been built and is awaiting a manual restart, or null. */
  pendingRestart: publicProcedure.query(() => ({
    version: getPendingRestartVersion(),
    running: KENNOOK_VERSION,
  })),
});
