import { router, adminProcedure } from '@/server/trpc';
import {
  getCloudStatus, startEnrollment, cancelEnrollment, disconnect,
} from '@/server/cloud/agent';
import { obtainCertificate } from '@/server/cloud/certs';

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

  /** Request (or force-renew) the wildcard TLS cert. Fire-and-forget: issuance
   *  takes ~a minute, so we kick it off and let the card poll `status` while
   *  `certPending` is true, mirroring the enrollment flow. */
  requestCert: adminProcedure.mutation(() => { void obtainCertificate({ force: true }); return { started: true }; }),
});
