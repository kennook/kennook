import type { NextRequest } from 'next/server';
import {
  addSubscriber, removeSubscriber, getScreensaverState,
  assignScreensaverIndex,
  type Subscriber,
} from '@/server/sync-broker';

// Long-lived streaming response — needs the Node runtime (Edge has aggressive
// connection limits and lacks `req.signal` semantics we rely on here).
export const runtime = 'nodejs';
// Disable static optimization for this route.
export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events endpoint. Each open tab holds one stream alive; the
 * server pushes JSON payloads (one per `data:` frame) whenever a mutation
 * elsewhere — or a client publish via /api/sync/publish — fans out to the
 * user. EventSource on the client side handles auto-reconnect for free.
 *
 * Why not WebSockets: this traffic is one-way (server → client). SSE is a
 * regular HTTP response with no upgrade handshake, no framing layer, no
 * ping/pong, and reconnects without code. For Kennook's broadcast pattern
 * it's lighter to write and lighter at runtime.
 */
export async function GET(req: NextRequest) {
  const userId = 1; // single-user v0.1; will be derived from auth later

  const encoder = new TextEncoder();
  let sub: Subscriber | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (frame: string) => {
        try { controller.enqueue(encoder.encode(frame)); }
        catch { /* stream closed — best-effort */ }
      };
      sub = { userId, send };
      addSubscriber(sub);

      // Initial comment flushes headers immediately so the client knows
      // the stream is open before any real event arrives.
      send(': hi\n\n');

      // Snapshot of ephemeral state for this (re)connecting tab. Critical
      // for mobile: if the SSE stream was throttled/paused (e.g. iOS
      // Safari with the screen off) and a dismiss event was missed, the
      // first thing the freshly-reconnected stream gets is the truth.
      // sessionId 'server-snapshot' won't match any real tab's id, so
      // every client processes it.
      send(`data: ${JSON.stringify({
        sessionId: 'server-snapshot',
        event: { type: 'screensaver', open: getScreensaverState(userId) },
      })}\n\n`);

      // Per-tab screensaver assignment — monotonic per user, so the first
      // N open tabs draw N distinct videos (modulo manifest size, which
      // the client knows). Sent once per connection.
      send(`data: ${JSON.stringify({
        sessionId: 'server-snapshot',
        event: { type: 'screensaver.assignment', index: assignScreensaverIndex(userId) },
      })}\n\n`);

      // Heartbeat at 25s — under typical reverse-proxy idle timeouts
      // (Cloudflare 100s, nginx 60s default, Cloud Run 600s). Cheap: a
      // 5-byte comment per active stream per 25s.
      heartbeat = setInterval(() => send(': hb\n\n'), 25_000);

      // Client closed the tab / navigated away.
      req.signal.addEventListener('abort', () => {
        if (heartbeat) clearInterval(heartbeat);
        if (sub) removeSubscriber(sub);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (sub) removeSubscriber(sub);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Tells nginx not to buffer the stream — without this, frames pile up
      // and the client sees nothing until the buffer fills.
      'X-Accel-Buffering': 'no',
    },
  });
}
