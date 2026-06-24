/**
 * POST /api/auth/anonymous — sign in as the shared anonymous Viewer (no
 * password). Gated by the "Anonymous viewing" config flag. Anonymous users
 * all share one pooled account; named accounts are private.
 */

import { AUTH_COOKIE_NAME, DEFAULT_USER_ID, signSession } from '@/server/auth';
import { getConfigValue } from '@/server/app-config';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  if (!getConfigValue('auth.anonymousViewing')) {
    return Response.json({ error: 'Anonymous viewing is disabled on this instance.' }, { status: 403 });
  }
  const maxAge = 60 * 60 * 24 * 400; // ~persistent
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${AUTH_COOKIE_NAME}=${signSession(DEFAULT_USER_ID)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    },
  });
}
