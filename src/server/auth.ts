/**
 * Auth — Phase 0 (deliberately simple).
 *
 * The session is a plain `kennook_user` cookie holding a user id. No
 * password, no signing, no expiry. Anyone who can edit cookies can
 * pose as any user — fine for local-network single-machine use, NOT
 * fine once KenNook is distributed beyond the operator's own LAN.
 *
 * When distribution lands (per the kennook.net infra plan), replace
 * this whole module with the OAuth flow used for `<name>.app.kennook.net`
 * — the public API (`getCurrentUser`, `requireAdmin`) stays the same.
 *
 * Users are seeded by the user.db v4→v5 migration:
 *   id=1 'Viewer'  role='viewer'  (anonymous default — anyone on the LAN)
 *   id=2 'Admin'   role='admin'   (operator — gates /admin)
 *
 * All existing user-scoped data (likes, playlists, settings) still
 * lives under user_id = 1 — the role system is overlaid for access
 * control, NOT data separation. Per-user data isolation is a separate
 * future change.
 */

import { getUserSqlite } from '@/db/user-client';

export const AUTH_COOKIE_NAME = 'kennook_user';
/** Default user id when no cookie is present — every visitor is the
 *  anonymous Viewer until they pick a different account at /login. */
export const DEFAULT_USER_ID = 1;

export type UserRole = 'viewer' | 'admin';

export interface AppUser {
  id: number;
  name: string;
  role: UserRole;
}

/**
 * Parse the `kennook_user` cookie out of a raw `Cookie:` header and
 * return the user id, or `DEFAULT_USER_ID` if missing/invalid.
 */
export function parseUserCookie(cookieHeader: string | null | undefined): number {
  if (!cookieHeader) return DEFAULT_USER_ID;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === AUTH_COOKIE_NAME) {
      const raw = rest.join('=');
      const n = parseInt(decodeURIComponent(raw), 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return DEFAULT_USER_ID;
}

/**
 * Resolve the current user from a request. Falls back to the seeded
 * Viewer if the cookie is missing or its id doesn't match a known
 * row — so a deleted user or a stale cookie gracefully degrades to
 * read-only access rather than 500ing.
 */
export function getCurrentUser(cookieHeader: string | null | undefined): AppUser {
  const id = parseUserCookie(cookieHeader);
  const db = getUserSqlite();
  const row = db.prepare(
    `SELECT id, name, role FROM users WHERE id = ?`,
  ).get(id) as { id: number; name: string; role: string } | undefined;
  if (row && (row.role === 'viewer' || row.role === 'admin')) {
    return { id: row.id, name: row.name, role: row.role };
  }
  // Fallback — cookie pointed at a non-existent user.
  const viewer = db.prepare(
    `SELECT id, name, role FROM users WHERE id = ?`,
  ).get(DEFAULT_USER_ID) as { id: number; name: string; role: string };
  return { id: viewer.id, name: viewer.name, role: viewer.role as UserRole };
}

/** True iff the current user holds the admin role. */
export function isAdmin(user: AppUser): boolean {
  return user.role === 'admin';
}

/** List every user — used by the /login picker UI. */
export function listUsers(): AppUser[] {
  const db = getUserSqlite();
  const rows = db.prepare(
    `SELECT id, name, role FROM users ORDER BY id`,
  ).all() as { id: number; name: string; role: string }[];
  return rows
    .filter((r) => r.role === 'viewer' || r.role === 'admin')
    .map((r) => ({ id: r.id, name: r.name, role: r.role as UserRole }));
}
