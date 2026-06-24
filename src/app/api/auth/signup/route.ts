/**
 * POST /api/auth/signup — create a named account and sign in. Gated by the
 * "Self-service signup" config flag (off → only an admin can add accounts).
 * Body: { name, password }.
 */

import { NextRequest } from 'next/server';
import { AUTH_COOKIE_NAME, createUser, signSession } from '@/server/auth';
import { getConfigValue } from '@/server/app-config';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  if (!getConfigValue('auth.selfSignup')) {
    return Response.json({ error: 'Sign-ups are disabled on this instance.' }, { status: 403 });
  }
  let body: { name?: string; password?: string };
  try { body = await req.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  let user;
  try {
    user = createUser(String(body.name ?? ''), String(body.password ?? ''), 'viewer');
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Could not create account' }, { status: 400 });
  }

  const maxAge = 60 * 60 * 24 * 400;
  return new Response(JSON.stringify({ ok: true, user }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${AUTH_COOKIE_NAME}=${signSession(user.id)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    },
  });
}
