/**
 * In-process pub/sub broker for cross-session events.
 *
 * Subscribers are open SSE streams; publishers are either server-side
 * (mutation handlers calling `publishToUser` after a DB write) or
 * client-side (the `/api/sync/publish` endpoint forwarding browser-only
 * events like screensaver state).
 *
 * Single-process assumption — works for KenNook's self-hosted footprint.
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

// Solo-audio marker: the LAST window to unmute, as "<serverMs>:<sessionId>".
// Persisted (like the screensaver) so cross-process devices — which never see
// the in-memory SSE broadcast — converge via the /api/sync/state poll: a poller
// mutes when it reads a marker whose session isn't its own.
const AUDIO_SOLO_KEY = 'audio.solo';

export function setAudioSolo(userId: number, token: string): void {
  const db = getUserSqlite();
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE
      SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, AUDIO_SOLO_KEY, token, Date.now());
}

export function getAudioSolo(userId: number): string | null {
  const db = getUserSqlite();
  const row = db.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(userId, AUDIO_SOLO_KEY) as { value: string | null } | undefined;
  return row?.value ?? null;
}

// Sidebar "data revision" — bumped on any change to the per-user sidebar lists
// (playlists, saved searches, external sources). Persisted so cross-process
// devices (which miss the in-memory SSE broadcast) converge via the
// /api/sync/state poll: a poller refetches those lists when the rev changes.
const DATA_REV_KEY = 'data.rev';

export function bumpDataRev(userId: number): void {
  const db = getUserSqlite();
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE
      SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, DATA_REV_KEY, String(Date.now()), Date.now());
}

export function getDataRev(userId: number): string | null {
  const db = getUserSqlite();
  const row = db.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(userId, DATA_REV_KEY) as { value: string | null } | undefined;
  return row?.value ?? null;
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
  const frame = serialize(payload);
  if (!frame) return;
  for (const s of subscribers) {
    if (s.userId === userId) s.send(frame);
  }
}

/**
 * Fan out to EVERY active stream, regardless of user — for GLOBAL events that
 * everyone shares: instance config and shared-media changes (rotation,
 * sensitivity, exclude, move, tags, per-asset framing). Personal events (likes,
 * playlists, saved searches, and now the screensaver) use `publishToUser`.
 */
export function publishToAll(payload: unknown): void {
  const frame = serialize(payload);
  if (!frame) return;
  for (const s of subscribers) s.send(frame);
}

function serialize(payload: unknown): string | null {
  try {
    return `data: ${JSON.stringify(payload)}\n\n`;
  } catch {
    return null; // unserializable — skip rather than throw in a mutation
  }
}
