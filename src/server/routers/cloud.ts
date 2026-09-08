import { router, adminProcedure } from '@/server/trpc';
import {
  getCloudStatus, startEnrollment, cancelEnrollment, disconnect,
} from '@/server/cloud/agent';

/**
 * Admin controls for the cloud connection (KenNook cloud spine). All admin-only.
 * Every handler is safe when cloud is off — `getCloudStatus` reports `enabled:
 * false` and the mutations throw a clear message.
 */
export const cloudRouter = router({
  status: adminProcedure.query(() => getCloudStatus()),

  /** Begin device-code enrollment; returns the code + URL to approve it. */
  connect: adminProcedure.mutation(() => startEnrollment()),

  /** Abandon an in-progress enrollment. */
  cancel: adminProcedure.mutation(() => { cancelEnrollment(); return { ok: true }; }),

  /** Forget this instance's cloud identity entirely. */
  disconnect: adminProcedure.mutation(() => { disconnect(); return { ok: true }; }),
});
