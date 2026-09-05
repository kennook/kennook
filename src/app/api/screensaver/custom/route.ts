/**
 * GET /api/screensaver/custom — admin-uploaded screensaver clips that are
 * transcoded and ready to play, as `{ id, loop }[]`. Public (the screensaver
 * shows to any viewer). The client prefers these over the built-in set when the
 * list is non-empty; each id resolves to /api/screensaver/media/<id>/<720|1080>
 * (with `?loop=1` when `loop` is true, to play the seamless boomerang variant).
 */

import { readyScreensaverClips } from '@/server/screensavers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json(readyScreensaverClips(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
