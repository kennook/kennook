/**
 * Return the currently-signed-in user. Falls back to the seeded Viewer
 * when no cookie is set, so this endpoint never 401s — callers can
 * always render something.
 */

import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/server/auth';

export const runtime = 'nodejs';
// Always read fresh — the cookie can change at any time and we don't
// want a CDN/edge-cached `me` response.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const user = getCurrentUser(req.headers.get('cookie'));
  return Response.json(user);
}
