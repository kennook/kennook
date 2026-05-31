/**
 * GET /api/sync/state  — the cross-device shared UI state, read from the DB.
 *
 * The SSE broker (publishToUser) is in-memory, so it only reaches devices on
 * the SAME server process. With caddy fronting a prod build (:3001) AND a dev
 * server (:3000), devices split across two processes never see each other's
 * live broadcasts. But they DO share one `user.db`, so polling this endpoint
 * lets every device converge on the persisted truth regardless of which
 * process (or origin) it's connected to.
 *
 * Structured as an object so future shared toggles (mute/unmute, etc.) slot
 * in without a new endpoint.
 */

import { NextRequest } from 'next/server';
import { getScreensaverState } from '@/server/sync-broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest): Promise<Response> {
  const userId = 1; // single-user v0.1
  return Response.json(
    { screensaver: getScreensaverState(userId) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
