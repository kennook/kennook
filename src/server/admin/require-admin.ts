/**
 * Helper for API route handlers under /api/admin — pulls the current
 * user from the request and returns a 403 Response when they aren't
 * an admin. Pattern in each route:
 *
 *     const guard = requireAdmin(req);
 *     if (guard) return guard;            // 403 short-circuit
 *     // ...continue handling, guard.user is the AppUser
 *
 * The full helper returns either a Response (to be returned directly)
 * OR an object { user } for the happy path.
 */

import { NextRequest } from 'next/server';
import { getCurrentUser, isAdmin, type AppUser } from '@/server/auth';

export function requireAdmin(req: NextRequest):
  | { response?: never; user: AppUser }
  | { response: Response; user?: never }
{
  const user = getCurrentUser(req.headers.get('cookie'));
  if (!isAdmin(user)) {
    return {
      response: Response.json(
        { error: 'Admin role required' },
        { status: 403 },
      ),
    };
  }
  return { user };
}
