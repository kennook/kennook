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
// The DEVICE id (see lib/device-id.ts) that started the current screensaver, so
// every device — including cross-process ones that only poll — can tell whether
// it's the owner when the "only the starting device can dismiss" rule is on.
const SCREENSAVER_OWNER_KEY = 'screensaver.owner';

export function setScreensaverState(userId: number, open: boolean, owner?: string | null): void {
  const db = getUserSqlite();
  if (open) {
    db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, '1', ?)
      ON CONFLICT (user_id, key) DO UPDATE
        SET value = excluded.value, updated_at = excluded.updated_at
    `).run(userId, SCREENSAVER_KEY, Date.now());
    // Record (or clear) the originating device. Only overwrite when a value is
    // provided, so a plain re-assert of "open" doesn't wipe a known owner.
    if (owner) {
      db.prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, key) DO UPDATE
          SET value = excluded.value, updated_at = excluded.updated_at
      `).run(userId, SCREENSAVER_OWNER_KEY, owner, Date.now());
    }
  } else {
    db.prepare(
      'DELETE FROM user_settings WHERE user_id = ? AND key IN (?, ?)',
    ).run(userId, SCREENSAVER_KEY, SCREENSAVER_OWNER_KEY);
  }
}

export function getScreensaverState(userId: number): boolean {
  const db = getUserSqlite();
  const row = db.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(userId, SCREENSAVER_KEY) as { value: string | null } | undefined;
  return row?.value === '1';
}

/** The device id that started the current screensaver, or null. */
export function getScreensaverOwner(userId: number): string | null {
  const db = getUserSqlite();
  const row = db.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(userId, SCREENSAVER_OWNER_KEY) as { value: string | null } | undefined;
  return row?.value ?? null;
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

// Instance config revision — bumped on any admin config change. Global (not
// per-user), persisted so cross-process devices (which miss the in-memory SSE
// `config.changed`) converge via the /api/sync/state poll: a poller emits
// `config.changed` locally when the rev changes, and clients refetch config.
const CONFIG_REV_KEY = 'config.rev';
const CONFIG_REV_USER_ID = 1; // matches app-config's single-user global scope

export function bumpConfigRev(): void {
  const db = getUserSqlite();
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE
      SET value = excluded.value, updated_at = excluded.updated_at
  `).run(CONFIG_REV_USER_ID, CONFIG_REV_KEY, String(Date.now()), Date.now());
}

export function getConfigRev(): string | null {
  const db = getUserSqlite();
  const row = db.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(CONFIG_REV_USER_ID, CONFIG_REV_KEY) as { value: string | null } | undefined;
  return row?.value ?? null;
}

// Media "result-membership" revision — bumped whenever a change could alter
// which items appear in a list/search result (new media indexed, tags added/
// removed, likes changed, exclude/move/sensitivity). Persisted so every device
// — including cross-process ones and the separate indexer process, which can't
// SSE — converges via the /api/sync/state poll. Global (not per-user): media and
// its tags are shared across the operator's viewer accounts. The CLIENT reacts
// to a change lazily (refetch only at a safe boundary — top of grid, screensaver,
// viewer close, slideshow wrap), so results never yank out from under a viewer.
const MEDIA_REV_KEY = 'media.rev';
const MEDIA_REV_USER_ID = 1;

export function bumpMediaRev(): void {
  const db = getUserSqlite();
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE
      SET value = excluded.value, updated_at = excluded.updated_at
  `).run(MEDIA_REV_USER_ID, MEDIA_REV_KEY, String(Date.now()), Date.now());
}

export function getMediaRev(): string | null {
  const db = getUserSqlite();
  const row = db.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(MEDIA_REV_USER_ID, MEDIA_REV_KEY) as { value: string | null } | undefined;
  return row?.value ?? null;
}

// Published events whose change can alter which items appear in a list/search
// result → bump the media rev so other devices refresh (at a safe boundary).
// Kept here (not at each call site) so every current + future publish of these
// types is covered automatically. New media from the indexer bumps the rev
// directly (it doesn't publish an SSE event — different process).
const MEDIA_MEMBERSHIP_EVENTS = new Set([
  'item.like',        // a min-likes filter can gain/lose this item
  'item.excluded',    // drops out of every result set
  'items.moved',      // leaves the source library's results
  'item.sensitive',   // a sensitivity filter can gain/lose it
  'item.tag.changed', // a tag / text search can gain/lose it
  'item.rotation',    // flips orientation → an orientation filter can gain/lose it
]);
function maybeBumpMediaRev(payload: unknown): void {
  const t = (payload as { event?: { type?: string } } | null)?.event?.type;
  if (t && MEDIA_MEMBERSHIP_EVENTS.has(t)) bumpMediaRev();
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
  maybeBumpMediaRev(payload);
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
  maybeBumpMediaRev(payload);
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
