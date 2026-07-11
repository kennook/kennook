import type { NextRequest } from 'next/server';
import { publishToAll, publishToUser, setScreensaverState } from '@/server/sync-broker';
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

  // Screensaver is PER-USER: only the signed-in user's own windows/devices
  // see it, and its state persists under that user's id so a (re)connecting
  // tab syncs to their own truth. Other client events (e.g. audio.unmuted)
  // remain global — they concern a shared physical display.
  const evt = (payload as { event?: { type?: string; open?: boolean } })?.event;
  if (evt?.type === 'screensaver' && typeof evt.open === 'boolean') {
    const userId = getSession(req.headers.get('cookie')).userId;
    setScreensaverState(userId, evt.open);
    publishToUser(userId, payload);
  } else {
    publishToAll(payload);
  }
  return new Response(null, { status: 204 });
}
