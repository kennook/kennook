/**
 * Screensaver lock.
 *
 * Gates dismissing the walk-away screensaver. Two ways to unlock, chosen per
 * session by `lockModeFor`:
 *
 *   • A signed-in NAMED user with a password unlocks with that ACCOUNT
 *     PASSWORD — the screensaver acts as a screen-lock over their session
 *     (mode `'password'`).
 *   • Everyone else — the anonymous Viewer, a kiosk display, or a named user
 *     with no password — unlocks with the shared numeric PASSCODE
 *     (mode `'passcode'`).
 *
 * The passcode is a numeric PIN (4, 6, or 8 digits — the admin's choice),
 * deliberately distinct from the alphanumeric account password so the prompt can
 * be unambiguous. It also acts as the on-switch: with no passcode set, the lock
 * is off for the anonymous/kiosk path (mode `'none'`), and the admin owns it.
 *
 * Stored as a salted scrypt hash in the shared `user_settings` bag so both
 * the prod and dev Node processes — which share one user.db — agree on it.
 *
 * Threat model: this deters a casual passer-by at an unattended screen. It is
 * NOT bank-grade — the screensaver is a DOM overlay and the "unlocked" state
 * is shared cross-device — but the account-password path makes it a real
 * screen-lock for a signed-in user.
 */

import { getUserSqlite } from '@/db/user-client';
import { hashSecret, verifySecret } from '@/server/secret-hash';
import { DEFAULT_USER_ID, userHasPassword, verifyUserPassword } from '@/server/auth';

// App-global lock — stored under the single-user v0.1 id, matching the rest
// of the user-scoped data and the screensaver state itself.
const LOCK_USER_ID = 1;
const LOCK_KEY = 'screensaver.lock.hash';
const LENGTH_KEY = 'screensaver.lock.length';

/** Allowed passcode lengths — a plain 4-digit PIN, or a longer 6/8 for power
 *  users who want more entropy. */
export const PASSCODE_LENGTHS = [4, 6, 8] as const;
/** Default length when none is stored. */
export const PASSCODE_LENGTH = 4;

/** The stored passcode length (number of digits), defaulting to PASSCODE_LENGTH.
 *  Drives how many entry boxes the unlock prompt renders. */
export function getPasscodeLength(): number {
  const db = getUserSqlite();
  const row = db
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(LOCK_USER_ID, LENGTH_KEY) as { value: string | null } | undefined;
  const n = Number(row?.value);
  return (PASSCODE_LENGTHS as readonly number[]).includes(n) ? n : PASSCODE_LENGTH;
}

/** How the current session must unlock the screensaver. */
export type LockMode = 'none' | 'password' | 'passcode';

/** The stored `scrypt$<saltHex>$<hashHex>` string, or null when unset. */
function readStored(): string | null {
  const db = getUserSqlite();
  const row = db
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(LOCK_USER_ID, LOCK_KEY) as { value: string | null } | undefined;
  const v = row?.value?.trim();
  return v ? v : null;
}

/** Whether a numeric passcode is currently set (the lock's on-switch for the
 *  anonymous/kiosk path). */
export function isLockEnabled(): boolean {
  return readStored() !== null;
}

/**
 * Set (non-empty) or clear (empty/blank) the screensaver passcode. The passcode
 * must be all digits and one of PASSCODE_LENGTHS (4/6/8); anything else throws.
 * The chosen length is remembered so the unlock prompt renders the right number
 * of boxes. Clearing removes the rows so the anonymous/kiosk path reverts to
 * dismiss-on-any-gesture.
 */
export function setLockPasscode(passcode: string | null | undefined): void {
  const db = getUserSqlite();
  const trimmed = (passcode ?? '').trim();
  if (!trimmed) {
    // Clear both the hash and the remembered length.
    db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key IN (?, ?)')
      .run(LOCK_USER_ID, LOCK_KEY, LENGTH_KEY);
    return;
  }
  if (!/^\d+$/.test(trimmed) || !(PASSCODE_LENGTHS as readonly number[]).includes(trimmed.length)) {
    throw new Error(`Passcode must be ${PASSCODE_LENGTHS.join(', ')} digits.`);
  }
  const upsert = db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(user_id, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  upsert.run(LOCK_USER_ID, LOCK_KEY, hashSecret(trimmed));
  upsert.run(LOCK_USER_ID, LENGTH_KEY, String(trimmed.length));
}

/**
 * Constant-time check of a candidate passcode. Returns true when no passcode
 * is set (nothing to verify against), so callers can treat "unlocked" and
 * "no lock" uniformly.
 */
export function verifyPasscode(passcode: string): boolean {
  const stored = readStored();
  if (!stored) return true;
  return verifySecret(stored, passcode);
}

/**
 * How the given session must unlock the screensaver:
 *   - 'password' — a signed-in named user with a password (use that password)
 *   - 'passcode' — anonymous/kiosk or passwordless user
 *   - 'none'     — no lock applies; a dismiss gesture exits immediately
 *
 * The passcode is the master on-switch: with none set the lock is off for
 * everyone (so the admin's "Remove lock" means off, not "off for anonymous
 * only"). When it's set, a signed-in named user unlocks with their account
 * password instead of the shared passcode.
 */
export function lockModeFor(userId: number): LockMode {
  if (!isLockEnabled()) return 'none';
  if (userId !== DEFAULT_USER_ID && userHasPassword(userId)) return 'password';
  return 'passcode';
}

/**
 * Verify a dismiss attempt for the given session against whichever credential
 * its `lockModeFor` requires. Returns true (unlocked) when no lock applies.
 */
export function verifyLockInput(userId: number, input: string): boolean {
  switch (lockModeFor(userId)) {
    case 'none': return true;
    case 'password': return verifyUserPassword(userId, input);
    case 'passcode': return verifyPasscode(input);
  }
}
