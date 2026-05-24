/**
 * In-process pub/sub broker for cross-session events.
 *
 * Subscribers are open SSE streams; publishers are either server-side
 * (mutation handlers calling `publishToUser` after a DB write) or
 * client-side (the `/api/sync/publish` endpoint forwarding browser-only
 * events like screensaver state).
 *
 * Single-process assumption — works for Kennook's self-hosted footprint.
 * If we ever cluster the web tier, swap the Set for a Redis pubsub channel
 * (or equivalent) and keep the function shape identical.
 */
import { getUserSqlite } from '@/db/user-client';

export interface Subscriber {
  userId: number;
  send: (sseFrame: string) => void;
}

const subscribers = new Set<Subscriber>();

// Monotonic counter per user — each new SSE connection gets the next int.
// The client mods this by the screensaver-manifest size, so the first N
// open tabs all get unique videos when N ≤ manifest.length.
const nextScreensaverIndex = new Map<number, number>();
export function assignScreensaverIndex(userId: number): number {
  const cur = nextScreensaverIndex.get(userId) ?? 0;
  nextScreensaverIndex.set(userId, cur + 1);
  return cur;
}

// Cross-tab state that needs to survive a single-tab reload (or even a
// dev-server restart). Stored in user.db's `user_settings` table rather
// than memory, so a (re)connecting tab — desktop reload, mobile waking
// up from throttle, a fresh device — always sees the persisted truth via
// the snapshot frame written at SSE-connect time.
const SCREENSAVER_KEY = 'screensaver.open';

export function setScreensaverState(userId: number, open: boolean): void {
  const db = getUserSqlite();
  if (open) {
    db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, '1', ?)
      ON CONFLICT (user_id, key) DO UPDATE
        SET value = excluded.value, updated_at = excluded.updated_at
    `).run(userId, SCREENSAVER_KEY, Date.now());
  } else {
    db.prepare(
      'DELETE FROM user_settings WHERE user_id = ? AND key = ?',
    ).run(userId, SCREENSAVER_KEY);
  }
}

export function getScreensaverState(userId: number): boolean {
  const db = getUserSqlite();
  const row = db.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(userId, SCREENSAVER_KEY) as { value: string | null } | undefined;
  return row?.value === '1';
}

export function addSubscriber(s: Subscriber): void {
  subscribers.add(s);
}

export function removeSubscriber(s: Subscriber): void {
  subscribers.delete(s);
  // State persists across disconnects now — don't clear on the last tab
  // closing. The user explicitly dismisses the screensaver to clear it;
  // reload / close-and-reopen should restore.
}

/**
 * Fan out a JSON-serializable payload to every active SSE stream for
 * the given user. Callers should include a `sessionId` in the payload so
 * the originating tab can skip its own event on receipt.
 */
export function publishToUser(userId: number, payload: unknown): void {
  let frame: string;
  try {
    frame = `data: ${JSON.stringify(payload)}\n\n`;
  } catch {
    return; // unserializable payload — skip rather than throw in a mutation
  }
  for (const s of subscribers) {
    if (s.userId === userId) s.send(frame);
  }
}
