/**
 * Sign in as a user account.
 *
 * POST body: `{ userId: number, password?: string }`. The account must
 * exist; if it has a password configured, `password` must match. On
 * success we set the `kennook_user` cookie to an HMAC-SIGNED session value
 * (see server/auth.ts) so it can't be forged by hand-editing the cookie.
 *
 * Used by the /login picker. Sign out via /api/auth/logout.
 */

import { NextRequest } from 'next/server';
import {
  AUTH_COOKIE_NAME,
  listUsers,
  userHasPassword,
  verifyUserPassword,
  signSession,
} from '@/server/auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { userId?: number; password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const userId = body.userId;
  if (!Number.isInteger(userId) || (userId as number) <= 0) {
    return Response.json({ error: 'Invalid userId' }, { status: 400 });
  }
  const known = listUsers().some((u) => u.id === userId);
  if (!known) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }
  if (userHasPassword(userId!) && !verifyUserPassword(userId!, body.password ?? '')) {
    return Response.json({ error: 'Incorrect password' }, { status: 401 });
  }
  // 400 days = the max age Chrome will honor; effectively persistent.
  const maxAge = 60 * 60 * 24 * 400;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${AUTH_COOKIE_NAME}=${signSession(userId!)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    },
  });
}
