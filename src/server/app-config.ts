/**
 * Instance configuration — admin-toggleable settings for THIS KenNook.
 *
 * This is "stage 1" of what `lib/feature-flags.ts` described: the schema below
 * is the source of truth for shape + defaults; per-instance overrides live in
 * the shared `user_settings` table (key `config.<key>`). Add a new toggle by
 * appending to CONFIG_SCHEMA — the admin Configuration UI renders it
 * automatically and `getConfigValue` reads it.
 */

import { getUserSqlite } from '@/db/user-client';

// App-global config under the single-user v0.1 id.
const CONFIG_USER_ID = 1;
const STORAGE_PREFIX = 'config.';

export interface ConfigItem {
  key: string;
  label: string;
  description: string;
  default: boolean;
}

export const CONFIG_SCHEMA: ConfigItem[] = [
  {
    key: 'screensaver.enabled',
    label: 'Screensaver',
    description:
      'Allow the walk-away screensaver to be triggered on this instance. ' +
      'When off, the S shortcut and the screensaver are disabled everywhere.',
    default: true,
  },
];

const SCHEMA_BY_KEY = new Map(CONFIG_SCHEMA.map((c) => [c.key, c]));

export interface ResolvedConfigItem extends ConfigItem {
  value: boolean;
}

/** The per-instance override for a key, or null when unset (use the default). */
function readOverride(key: string): boolean | null {
  const db = getUserSqlite();
  const row = db.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(CONFIG_USER_ID, STORAGE_PREFIX + key) as { value: string | null } | undefined;
  if (row?.value == null) return null;
  return row.value === '1';
}

/** Every config item with its resolved current value — powers the admin UI. */
export function listConfig(): ResolvedConfigItem[] {
  return CONFIG_SCHEMA.map((c) => ({ ...c, value: readOverride(c.key) ?? c.default }));
}

/** Resolved value for a single key (default when there's no override). */
export function getConfigValue(key: string): boolean {
  const item = SCHEMA_BY_KEY.get(key);
  if (!item) return false;
  return readOverride(key) ?? item.default;
}

/** Set a known config key. Throws on an unknown key. */
export function setConfigValue(key: string, value: boolean): void {
  if (!SCHEMA_BY_KEY.has(key)) throw new Error(`Unknown config key: ${key}`);
  const db = getUserSqlite();
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, unixepoch() * 1000)
    ON CONFLICT(user_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(CONFIG_USER_ID, STORAGE_PREFIX + key, value ? '1' : '0');
}
