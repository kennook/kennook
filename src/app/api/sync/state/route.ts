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
import { getScreensaverState, getAudioSolo, getDataRev, getConfigRev } from '@/server/sync-broker';
import { getSession } from '@/server/auth';
import { KENNOOK_BUILD_ID } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  // Per-user: each account's devices converge on their OWN shared UI state.
  const userId = getSession(req.headers.get('cookie')).userId;
  return Response.json(
    // `build` = the build id this server PROCESS is running (baked at build
    // time). Clients poll this as a heartbeat; on reconnect after an outage
    // they compare it to their own baked build to decide whether a stale
    // bundle (broken chunks) needs a hard reload or the page can just resume.
    {
      screensaver: getScreensaverState(userId),
      audio: getAudioSolo(userId),
      rev: getDataRev(userId),
      config: getConfigRev(),
      build: KENNOOK_BUILD_ID,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
