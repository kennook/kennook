'use client';

/**
 * A stable per-DEVICE identity — one id per browser profile, persisted in
 * localStorage so it survives reloads (unlike the per-tab SESSION_ID in
 * sync.tsx, which is regenerated every load). Used by the "only the device that
 * started the screensaver can dismiss it" rule: the originating device stamps
 * the screensaver with this id, and a reload of that same device still matches.
 *
 * Best-effort: if localStorage is unavailable (private mode, blocked), we fall
 * back to a volatile in-memory id so the app still works — the device just
 * won't be recognized as the owner after a reload in that session.
 */

const KEY = 'kennook.device.id';

let cached: string | null = null;

function makeId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** This device's stable id, creating + persisting one on first use. */
export function getDeviceId(): string {
  if (cached) return cached;
  if (typeof window === 'undefined') return (cached = makeId()); // SSR — volatile
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return (cached = existing);
    const id = makeId();
    localStorage.setItem(KEY, id);
    return (cached = id);
  } catch {
    return (cached = makeId()); // storage blocked — volatile fallback
  }
}
