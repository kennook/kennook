/**
 * Action HUD — a lightweight, framework-agnostic emitter that flashes a large
 * ghosted glyph over the media (like the macOS volume overlay). Any handler —
 * a keyboard shortcut OR a background sync event (e.g. a mute triggered by
 * another window/device) — calls `flashHud(...)`, and the mounted <ActionHud>
 * shows a brief "here's what just happened" glimpse.
 *
 * Singleton (module-level Set) rather than context so deep handlers in
 * VideoPlayer / MediaViewer / the sync layer can fire it without prop-drilling.
 * No listener mounted → no-op.
 */

export type HudIcon =
  | 'play' | 'pause'
  | 'mute' | 'unmute'
  | 'like'
  | 'next' | 'prev';

export interface HudFlash {
  icon: HudIcon;
  /** Optional short caption under the glyph (e.g. the new like count). */
  label?: string;
  /** Monotonic id so <ActionHud> restarts its animation on every flash. */
  id: number;
}

type Listener = (f: HudFlash) => void;
const listeners = new Set<Listener>();
let counter = 0;

export function flashHud(icon: HudIcon, label?: string): void {
  const flash: HudFlash = { icon, label, id: ++counter };
  for (const l of listeners) l(flash);
}

export function subscribeHud(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
