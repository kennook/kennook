/**
 * Switch to a different user account.
 *
 * POST body: `{ userId: number }` — must match an existing row in the
 * `users` table. On success, sets the `kennook_user` cookie. Plain
 * value, no signing — see `server/auth.ts` for the security caveat.
 *
 * Used by the /login picker. Logout is "clear the cookie in your
 * browser dev tools," matches the Phase-0 minimalism.
 */

import { NextRequest } from 'next/server';
import { AUTH_COOKIE_NAME, listUsers } from '@/server/auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { userId?: number };
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
  // 400 days = the max age Chrome will honor; effectively persistent.
  const maxAge = 60 * 60 * 24 * 400;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${AUTH_COOKIE_NAME}=${userId}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    },
  });
}
