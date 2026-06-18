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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getUserSqlite } from '@/db/user-client';
import { hashSecret, verifySecret } from '@/server/secret-hash';

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

// ── Signed sessions ──────────────────────────────────────────────────
//
// The cookie value is `<id>.<hmac>` where the hmac is HMAC-SHA256 of the id
// string under a per-instance secret. This means the password actually
// gates access: a session can't be forged by hand-editing the cookie to a
// user id (Phase 0's old behavior). It is still not bank-grade — the secret
// lives next to the data and there's no expiry/rotation — but it makes the
// login gate meaningful rather than theater.
//
// Secret is seeded once in the user.db v11 migration so both the prod and
// dev Node processes (which share user.db) sign/verify identically; the
// INSERT-OR-IGNORE fallback covers any DB that somehow lacks it.
let _secretCache: Buffer | null = null;
function getSessionSecret(): Buffer {
  if (_secretCache) return _secretCache;
  const db = getUserSqlite();
  const read = () =>
    (db.prepare('SELECT value FROM user_settings WHERE user_id = 1 AND key = ?')
      .get('auth.session_secret') as { value: string } | undefined)?.value;
  let hex = read();
  if (!hex) {
    db.prepare(
      `INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at)
         VALUES (1, ?, ?, unixepoch() * 1000)`,
    ).run('auth.session_secret', randomBytes(32).toString('hex'));
    hex = read(); // re-read so a concurrent writer's value wins consistently
  }
  _secretCache = Buffer.from(hex ?? randomBytes(32).toString('hex'), 'hex');
  return _secretCache;
}

/** Build the signed cookie value for a user id. */
export function signSession(userId: number): string {
  const sig = createHmac('sha256', getSessionSecret()).update(String(userId)).digest('hex');
  return `${userId}.${sig}`;
}

/** Pull the raw `kennook_user` value out of a `Cookie:` header. */
function rawAuthCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === AUTH_COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Verify a signed cookie, returning the user id only if the signature is
 *  valid. Null means "no valid session" (anonymous). */
function verifySignedCookie(cookieHeader: string | null | undefined): number | null {
  const raw = rawAuthCookie(cookieHeader);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const idStr = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const id = parseInt(idStr, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const expected = createHmac('sha256', getSessionSecret()).update(idStr).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

/**
 * Resolve the user id from a request cookie, falling back to
 * `DEFAULT_USER_ID` when there's no valid signed session. Kept for callers
 * that only need an id; use `getSession`/`isAuthenticated` when the
 * authenticated-vs-anonymous distinction matters.
 */
export function parseUserCookie(cookieHeader: string | null | undefined): number {
  return verifySignedCookie(cookieHeader) ?? DEFAULT_USER_ID;
}

/** Whether the request carries a valid signed session (vs. anonymous). */
export function isAuthenticated(cookieHeader: string | null | undefined): boolean {
  return verifySignedCookie(cookieHeader) !== null;
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

// ── Passwords & the app-wide login gate ──────────────────────────────

export interface LoginUser extends AppUser {
  /** Whether selecting this account requires a password. */
  hasPassword: boolean;
}

/** Users for the /login picker, annotated with whether each needs a
 *  password. The hash itself is never exposed. */
export function listLoginUsers(): LoginUser[] {
  const db = getUserSqlite();
  const rows = db.prepare(
    `SELECT id, name, role, password_hash FROM users ORDER BY id`,
  ).all() as { id: number; name: string; role: string; password_hash: string | null }[];
  return rows
    .filter((r) => r.role === 'viewer' || r.role === 'admin')
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role as UserRole,
      hasPassword: !!r.password_hash,
    }));
}

/** True iff the account has a password configured. */
export function userHasPassword(userId: number): boolean {
  const db = getUserSqlite();
  const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`)
    .get(userId) as { password_hash: string | null } | undefined;
  return !!row?.password_hash;
}

/**
 * Check a login password. Returns true for a passwordless account (nothing
 * to verify) so the caller can treat "no password" and "correct password"
 * uniformly; callers gate on `userHasPassword` to decide whether to prompt.
 */
export function verifyUserPassword(userId: number, password: string): boolean {
  const db = getUserSqlite();
  const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`)
    .get(userId) as { password_hash: string | null } | undefined;
  if (!row) return false;
  if (!row.password_hash) return true;
  return verifySecret(row.password_hash, password);
}

/** Set (non-empty) or clear (empty/null) a user's login password. */
export function setUserPassword(userId: number, password: string | null | undefined): void {
  const db = getUserSqlite();
  const trimmed = (password ?? '').trim();
  const hash = trimmed ? hashSecret(trimmed) : null;
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, userId);
}

/**
 * The whole-app login gate is ON when the default Viewer account — the one
 * every device lands on — has a password. With it on, an unauthenticated
 * request to an app route is bounced to /login. (Admin keeps its own
 * /admin layout gate on top of this.)
 */
export function isAuthGateEnabled(): boolean {
  return userHasPassword(DEFAULT_USER_ID);
}

/** Resolve the session: the signed-in user id and whether it's a real
 *  (signature-verified) session vs. an anonymous fallback. */
export function getSession(cookieHeader: string | null | undefined): {
  userId: number;
  authenticated: boolean;
} {
  const id = verifySignedCookie(cookieHeader);
  return id !== null
    ? { userId: id, authenticated: true }
    : { userId: DEFAULT_USER_ID, authenticated: false };
}
