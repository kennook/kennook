/**
 * Hot corners — a per-user map of the four screen corners to actions, macOS
 * style. Stored as one JSON row in `user_settings` (key `hot_corners`), scoped
 * to the user so it syncs across their devices.
 *
 * Two kinds of action (see src/lib/hot-corner.ts):
 *   - `screensaver`  — TRIGGER: fires once on entering the corner.
 *   - `hideControls` — HOLD: while the cursor is in the corner, the fullscreen
 *                      viewer lets its controls fade (the mouse-jiggler fix).
 * Default keeps `topLeft: 'hideControls'` so existing behavior is unchanged.
 */

import { getUserSqlite } from '@/db/user-client';
import {
  HOT_CORNER_ACTIONS,
  DEFAULT_HOT_CORNERS,
  type Corner,
  type HotCornerAction,
  type HotCornerMap,
} from '@/lib/hot-corner';

const SETTINGS_KEY = 'hot_corners';
const CORNERS: Corner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

function isAction(v: unknown): v is HotCornerAction {
  return typeof v === 'string' && (HOT_CORNER_ACTIONS as readonly string[]).includes(v);
}

/** The user's corner→action map, falling back to the default for any missing or
 *  invalid corner (so a partial/legacy value never throws). */
export function getHotCorners(userId: number): HotCornerMap {
  let stored: Record<string, unknown> = {};
  try {
    const row = getUserSqlite()
      .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, SETTINGS_KEY) as { value: string | null } | undefined;
    if (row?.value) stored = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    /* DB not ready or bad JSON — fall through to defaults. */
  }
  const out = { ...DEFAULT_HOT_CORNERS };
  for (const c of CORNERS) if (isAction(stored[c])) out[c] = stored[c] as HotCornerAction;
  return out;
}

/** Persist the full corner map (validated). Unknown actions are rejected. */
export function setHotCorners(userId: number, map: HotCornerMap): void {
  const clean: HotCornerMap = { ...DEFAULT_HOT_CORNERS };
  for (const c of CORNERS) {
    const v = map[c];
    if (!isAction(v)) throw new Error(`Invalid hot-corner action for ${c}: ${String(v)}`);
    clean[c] = v;
  }
  getUserSqlite().prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, unixepoch() * 1000)
    ON CONFLICT(user_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, SETTINGS_KEY, JSON.stringify(clean));
}
