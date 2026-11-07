'use client';

/**
 * Per-WINDOW shuffle salt.
 *
 * The shuffle seed lives in the URL (`?shuffle=<n>`), so two windows on the same
 * URL would share one order and show the same item at the same position — which
 * is exactly the "multiple screens playing the same file" problem. Mixing a
 * per-window salt into the seed gives each window its own permutation of the
 * SAME result set, so a wall of screens scatters independently (and a
 * simultaneous refresh can't converge them onto one record).
 *
 * The salt is generated once per page load — stable across pagination and the
 * slideshow walk within the session; a reload reshuffles just this one window,
 * which is fine. `crypto` keeps the collision chance between windows negligible.
 */

let salt: number | null = null;

function windowSalt(): number {
  if (salt != null) return salt;
  let v: number;
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    v = buf[0];
  } catch {
    v = Math.floor(Math.random() * 0x1_0000_0000);
  }
  salt = v >>> 0;
  return salt;
}

/**
 * Mix the base (URL) shuffle seed with this window's salt → a seed unique to
 * this window. Same murmur avalanche as the server's `shuffle_key`, so the
 * result is a well-distributed 32-bit int the shuffle ordering accepts.
 * Deterministic for the window's lifetime, so pages/reloads stay consistent.
 */
export function windowShuffleSeed(baseSeed: number): number {
  let h = (baseSeed ^ windowSalt()) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
