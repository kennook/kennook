/**
 * POST /api/auth/invalidate-all — admin-only. Rotates the per-instance
 * session secret so every signed cookie on every device fails verification,
 * forcing all users back to /login. The admin who triggers it is signed out
 * too (their own cookie is now invalid); we also expire it here for a clean
 * handoff to the login screen.
 */

import { NextRequest } from 'next/server';
import {
  AUTH_COOKIE_NAME,
  getCurrentUser,
  isAdmin,
  rotateSessionSecret,
} from '@/server/auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  // Check admin BEFORE rotating — the caller's (still-valid) cookie proves it.
  if (!isAdmin(getCurrentUser(req.headers.get('cookie')))) {
    return Response.json({ error: 'Admins only.' }, { status: 403 });
  }
  rotateSessionSecret();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`,
    },
  });
}
