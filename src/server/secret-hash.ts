/**
 * Salted scrypt hashing for secrets (passwords, the screensaver passphrase).
 *
 * Pure crypto — deliberately imports no DB module so any layer can use it
 * without risking an import cycle. Format: `scrypt$<saltHex>$<hashHex>`.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;

/** Hash a plaintext secret into a self-describing `scrypt$salt$hash` string. */
export function hashSecret(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time check of a candidate against a stored `scrypt$salt$hash`. */
export function verifySecret(stored: string | null | undefined, plain: string): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let actual: Buffer;
  try {
    actual = scryptSync(plain ?? '', Buffer.from(saltHex, 'hex'), expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
