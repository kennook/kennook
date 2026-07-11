import type { NextRequest } from 'next/server';
import { publishToUser, setScreensaverState } from '@/server/sync-broker';
import { getSession } from '@/server/auth';

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

  // Every client-published event is PER-USER UI/device state — the screensaver
  // and the solo-audio (unmute) rule — so it only reaches the signed-in user's
  // own windows/devices, never other accounts. Screensaver additionally
  // persists under the user's id so a (re)connecting tab syncs to their truth.
  const userId = getSession(req.headers.get('cookie')).userId;
  const evt = (payload as { event?: { type?: string; open?: boolean } })?.event;
  if (evt?.type === 'screensaver' && typeof evt.open === 'boolean') {
    setScreensaverState(userId, evt.open);
  }
  publishToUser(userId, payload);
  return new Response(null, { status: 204 });
}
