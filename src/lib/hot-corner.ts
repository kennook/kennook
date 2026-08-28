/**
 * Hot corners — pure types + geometry, shared by the server (validation +
 * storage) and the client (engine + viewer predicate). NO React here so the
 * server can import it; the client hooks live in `hot-corner-client.ts`.
 *
 * Each of the four screen corners maps to an action (macOS style):
 *   - 'off'          — nothing.
 *   - 'screensaver'  — TRIGGER: start the walk-away screensaver on entry.
 *   - 'hideControls' — HOLD: while the cursor sits here, the fullscreen viewer
 *                      lets its controls fade (so a parked mouse jiggler can't
 *                      keep them pinned open).
 */

export type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export const HOT_CORNER_ACTIONS = ['off', 'screensaver', 'hideControls'] as const;
export type HotCornerAction = typeof HOT_CORNER_ACTIONS[number];

/** Actions that fire once on ENTERING the corner (vs. hold actions consulted
 *  continuously while the cursor is inside it). */
export const TRIGGER_ACTIONS: readonly HotCornerAction[] = ['screensaver'];

export type HotCornerMap = Record<Corner, HotCornerAction>;

/** Default: top-left keeps the "let controls fade" behavior we shipped before
 *  hot corners were configurable, so nothing changes until the user opts in. */
export const DEFAULT_HOT_CORNERS: HotCornerMap = {
  topLeft: 'hideControls',
  topRight: 'off',
  bottomLeft: 'off',
  bottomRight: 'off',
};

/** Side length (px) of each corner's active square. */
export const CORNER_PX = 130;
/** Back-compat alias for callers that referenced the old dead-corner size. */
export const HIDE_CORNER_PX = CORNER_PX;

/** Which corner a viewport point sits in, or null if none. Uses the live
 *  viewport size so it works on any screen. */
export function cornerAt(
  x: number, y: number,
  vw: number = typeof window !== 'undefined' ? window.innerWidth : 0,
  vh: number = typeof window !== 'undefined' ? window.innerHeight : 0,
  size: number = CORNER_PX,
): Corner | null {
  const left = x <= size;
  const right = x >= vw - size;
  const top = y <= size;
  const bottom = y >= vh - size;
  if (top && left) return 'topLeft';
  if (top && right) return 'topRight';
  if (bottom && left) return 'bottomLeft';
  if (bottom && right) return 'bottomRight';
  return null;
}

export const CORNER_LABELS: Record<Corner, string> = {
  topLeft: 'Top-left', topRight: 'Top-right', bottomLeft: 'Bottom-left', bottomRight: 'Bottom-right',
};

export const ACTION_LABELS: Record<HotCornerAction, string> = {
  off: 'Off',
  screensaver: 'Start screensaver',
  hideControls: 'Hide controls (let them fade)',
};
