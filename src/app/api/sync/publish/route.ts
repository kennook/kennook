import type { NextRequest } from 'next/server';
import { publishToAll, setScreensaverState } from '@/server/sync-broker';
import { SHARED_DATA_USER_ID } from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Forwards a client-originated sync event to all other sessions for the
 * same user. The payload is opaque to the server — the client constructs
 * the envelope (including its `sessionId` for self-echo suppression) and
 * the server just fans it out via SSE.
 *
 * Server-initiated events (from tRPC mutations) bypass this route and call
 * `publishToUser` directly. This endpoint exists for client-only state
 * that the server doesn't otherwise know about — currently: screensaver
 * on/off.
 */
export async function POST(req: NextRequest) {
  let payload: unknown;
  try { payload = await req.json(); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  // The client-published events (screensaver, audio.unmuted) are GLOBAL — they
  // affect every window/device — so broadcast to all streams. Screensaver
  // state persists under the shared id so a (re)connecting tab syncs to truth.
  const evt = (payload as { event?: { type?: string; open?: boolean } })?.event;
  if (evt?.type === 'screensaver' && typeof evt.open === 'boolean') {
    setScreensaverState(SHARED_DATA_USER_ID, evt.open);
  }

  publishToAll(payload);
  return new Response(null, { status: 204 });
}
