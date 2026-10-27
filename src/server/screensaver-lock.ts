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
 * The shared secret is one the admin configures as either a numeric PASSCODE (a
 * PIN of a chosen length, PASSCODE_MIN_LENGTH..PASSCODE_MAX_LENGTH) or a
 * free-form PASSWORD (text, PASSWORD_MIN_LENGTH..PASSWORD_MAX_LENGTH) — see
 * `LockSecretType`. A short 4-digit PIN is easy to shoulder-surf, so a longer
 * passcode or a password is available for real security. The secret also acts
 * as the on-switch: with none set, the lock is off for the anonymous/kiosk path
 * (mode `'none'`), and the admin owns it. This shared secret is distinct from
 * the account password a signed-in named user unlocks with (mode `'password'`).
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
const TYPE_KEY = 'screensaver.lock.type';

/** The kind of SHARED secret the admin configured for the anonymous/kiosk
 *  unlock path: a numeric `passcode` (PIN of a chosen length) or a free-form
 *  `password` (text + confirmation). Distinct from the per-session account
 *  password a signed-in named user uses — see `lockModeFor`. */
export type LockSecretType = 'passcode' | 'password';

/** Free-form shared-password bounds (the `password` secret type). */
export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 128;

/** Passcode length bounds. The admin picks any length in this range; the
 *  passcode is then randomly generated at that length. 4 is the floor (a PIN),
 *  32 a sane ceiling that scrypt handles trivially and stays typeable. */
export const PASSCODE_MIN_LENGTH = 4;
export const PASSCODE_MAX_LENGTH = 32;
/** Default length when none is stored (what the admin's length picker starts
 *  at) — 6, since 4 is easily guessable. */
export const PASSCODE_LENGTH = 6;

/** The stored passcode length (number of digits), clamped into the allowed
 *  range and defaulting to PASSCODE_LENGTH. Drives how many entry boxes the
 *  unlock prompt renders. */
export function getPasscodeLength(): number {
  const db = getUserSqlite();
  const row = db
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(LOCK_USER_ID, LENGTH_KEY) as { value: string | null } | undefined;
  const n = Number(row?.value);
  if (Number.isInteger(n) && n >= PASSCODE_MIN_LENGTH && n <= PASSCODE_MAX_LENGTH) return n;
  return PASSCODE_LENGTH;
}

/** The configured shared-secret type. Defaults to `passcode` — both for a fresh
 *  install and for legacy locks set before the type was stored (they were all
 *  numeric passcodes). */
export function getLockSecretType(): LockSecretType {
  const db = getUserSqlite();
  const row = db
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(LOCK_USER_ID, TYPE_KEY) as { value: string | null } | undefined;
  return row?.value === 'password' ? 'password' : 'passcode';
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

/** Clear the shared secret entirely — the anonymous/kiosk path reverts to
 *  dismiss-on-any-gesture and the lock is off. */
export function clearLockSecret(): void {
  getUserSqlite()
    .prepare('DELETE FROM user_settings WHERE user_id = ? AND key IN (?, ?, ?)')
    .run(LOCK_USER_ID, LOCK_KEY, LENGTH_KEY, TYPE_KEY);
}

/**
 * Set the shared screensaver secret. `type` picks how it's validated and how the
 * unlock prompt renders it:
 *   - `passcode`: all digits, length in [PASSCODE_MIN_LENGTH, PASSCODE_MAX_LENGTH];
 *     the length is remembered so the prompt draws the right number of boxes.
 *   - `password`: free-form text, length in [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH];
 *     no length is stored (the prompt is a single field).
 * An empty value clears the lock. Only the salted hash is persisted.
 */
export function setLockSecret(type: LockSecretType, value: string): void {
  // For a passcode, surrounding whitespace is never meaningful; for a password
  // it could be, so only trim the passcode.
  const secret = type === 'passcode' ? value.trim() : value;
  if (!secret) { clearLockSecret(); return; }

  if (type === 'passcode') {
    if (!/^\d+$/.test(secret)
        || secret.length < PASSCODE_MIN_LENGTH
        || secret.length > PASSCODE_MAX_LENGTH) {
      throw new Error(`Passcode must be ${PASSCODE_MIN_LENGTH}–${PASSCODE_MAX_LENGTH} digits.`);
    }
  } else {
    if (secret.length < PASSWORD_MIN_LENGTH || secret.length > PASSWORD_MAX_LENGTH) {
      throw new Error(`Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`);
    }
  }

  const db = getUserSqlite();
  const upsert = db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(user_id, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  upsert.run(LOCK_USER_ID, LOCK_KEY, hashSecret(secret));
  upsert.run(LOCK_USER_ID, TYPE_KEY, type);
  if (type === 'passcode') {
    upsert.run(LOCK_USER_ID, LENGTH_KEY, String(secret.length));
  } else {
    // A password has no digit-box length — drop any stale value.
    db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?')
      .run(LOCK_USER_ID, LENGTH_KEY);
  }
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
