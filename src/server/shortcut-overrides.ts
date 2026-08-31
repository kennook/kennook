/**
 * Layered shortcut overrides — the tenant + user tiers, stored as validated JSON
 * blobs in `user_settings` (mirrors hot-corners). The device tier lives in the
 * browser (localStorage) and is combined client-side; see `src/lib/shortcuts.ts`
 * for the resolver that layers tenant → user → device → defaults with lock-down.
 *
 *   - tenant: instance-wide, admin-set, under the global id 1 (the same row
 *     `config.*` uses), key `shortcuts.tenant`.
 *   - user:   per-account, under the signed-in user's id, key `shortcuts.user`.
 *
 * Each entry is `{ keys?: string[]; locked?: boolean }`: `keys` overrides the
 * binding at that tier (an empty array = disabled), `locked` blocks every tier
 * below it.
 */

import { getUserSqlite } from '@/db/user-client';

export interface ShortcutOverride {
  keys?: string[];
  locked?: boolean;
}
export type ShortcutOverrideMap = Record<string, ShortcutOverride>;

const TENANT_USER_ID = 1; // instance-global row (the id `config.*` uses)
const TENANT_KEY = 'shortcuts.tenant';
const USER_KEY = 'shortcuts.user';

/** Keep only well-formed entries so a partial/legacy/hostile blob never throws
 *  and can't smuggle junk into the client resolver. Drops empty entries. */
export function sanitize(raw: unknown): ShortcutOverrideMap {
  const out: ShortcutOverrideMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const entry: ShortcutOverride = {};
    const keys = (v as { keys?: unknown }).keys;
    if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) entry.keys = keys as string[];
    const locked = (v as { locked?: unknown }).locked;
    if (typeof locked === 'boolean') entry.locked = locked;
    if (entry.keys !== undefined || entry.locked !== undefined) out[id] = entry;
  }
  return out;
}

function readMap(userId: number, key: string): ShortcutOverrideMap {
  try {
    const row = getUserSqlite()
      .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, key) as { value: string | null } | undefined;
    if (!row?.value) return {};
    return sanitize(JSON.parse(row.value));
  } catch {
    return {}; // DB not ready / bad JSON — fall back to no overrides.
  }
}

function writeMap(userId: number, key: string, map: ShortcutOverrideMap): void {
  getUserSqlite().prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, unixepoch() * 1000)
    ON CONFLICT(user_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, key, JSON.stringify(map));
}

export function getTenantOverrides(): ShortcutOverrideMap {
  return readMap(TENANT_USER_ID, TENANT_KEY);
}
export function setTenantOverrides(map: ShortcutOverrideMap): void {
  writeMap(TENANT_USER_ID, TENANT_KEY, sanitize(map));
}
export function getUserOverrides(userId: number): ShortcutOverrideMap {
  return readMap(userId, USER_KEY);
}
export function setUserOverrides(userId: number, map: ShortcutOverrideMap): void {
  writeMap(userId, USER_KEY, sanitize(map));
}
