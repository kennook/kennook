/**
 * GET /api/screensaver/custom — ids of admin-uploaded screensaver clips that
 * are transcoded and ready to play. Public (the screensaver shows to any
 * viewer). The client prefers these over the built-in set when the list is
 * non-empty; each id resolves to /api/screensaver/media/<id>/<720|1080>.
 */

import { readyScreensaverIds } from '@/server/screensavers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json(readyScreensaverIds(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
