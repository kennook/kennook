/**
 * Sign out — clear the `kennook_user` session cookie. With the app-wide
 * login gate on, the next request lands on /login.
 */

import { AUTH_COOKIE_NAME } from '@/server/auth';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`,
    },
  });
}
