/**
 * Screensaver lock — Phase 0 (deliberately simple).
 *
 * A single app-wide passphrase that, when set, must be entered to dismiss
 * the walk-away screensaver. Stored as a salted scrypt hash in the shared
 * `user_settings` bag (no schema migration needed) so both the prod and dev
 * Node processes — which share one user.db — agree on it.
 *
 * Threat model: this deters a casual passer-by at an unattended screen. It
 * is NOT real security — anyone who can edit cookies, open devtools, or call
 * the API directly can bypass it (the screensaver is a DOM overlay, and the
 * "unlocked" state is shared cross-device). Real device-trust + per-user auth
 * is the planned replacement; the verify/set API here stays the same shape.
 */

import { getUserSqlite } from '@/db/user-client';
import { hashSecret, verifySecret } from '@/server/secret-hash';

// App-global lock — stored under the single-user v0.1 id, matching the rest
// of the user-scoped data and the screensaver state itself.
const LOCK_USER_ID = 1;
const LOCK_KEY = 'screensaver.lock.hash';

/** The stored `scrypt$<saltHex>$<hashHex>` string, or null when unset. */
function readStored(): string | null {
  const db = getUserSqlite();
  const row = db
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(LOCK_USER_ID, LOCK_KEY) as { value: string | null } | undefined;
  const v = row?.value?.trim();
  return v ? v : null;
}

/** Whether a screensaver passphrase is currently set. */
export function isLockEnabled(): boolean {
  return readStored() !== null;
}

/**
 * Set (non-empty) or clear (empty/blank) the screensaver passphrase.
 * Clearing removes the row entirely so the screensaver reverts to the
 * no-password, dismiss-on-any-gesture behavior.
 */
export function setLockPassword(password: string | null | undefined): void {
  const db = getUserSqlite();
  const trimmed = (password ?? '').trim();
  if (!trimmed) {
    db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?')
      .run(LOCK_USER_ID, LOCK_KEY);
    return;
  }
  const stored = hashSecret(trimmed);
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(user_id, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LOCK_USER_ID, LOCK_KEY, stored);
}

/**
 * Constant-time check of a candidate passphrase. Returns true when no lock
 * is set (nothing to verify against), so callers can treat "unlocked" and
 * "no lock" uniformly.
 */
export function verifyLockPassword(password: string): boolean {
  const stored = readStored();
  if (!stored) return true;
  return verifySecret(stored, password);
}
