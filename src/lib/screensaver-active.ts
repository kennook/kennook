'use client';

import { useSyncExternalStore } from 'react';

/**
 * A tiny module-level signal for "is the screensaver covering the screen right
 * now" — the TRUE visible state, published by <Screensaver> while it renders.
 *
 * Kept OUTSIDE React context on purpose: the readers live in unrelated parts of
 * the tree (the app-content shroud and the reload watcher, both mounted up in
 * the provider tree) while the writer is deep inside HomeClient. A plain
 * singleton lets them share the state without threading props through the app.
 *
 * Readers: `useScreensaverActive` (reactive, in the shroud) drives hiding the
 * rest of the app; `getScreensaverActive` (imperative) lets the reload watcher
 * decide, at event time, whether to update silently.
 */

let active = false;
const listeners = new Set<() => void>();

/** Called by <Screensaver> as it starts/stops covering the screen. */
export function setScreensaverActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const l of listeners) l();
}

export function getScreensaverActive(): boolean {
  return active;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Reactive read for components that should re-render when it flips. Returns
 *  false during SSR (the screensaver is a client-only overlay). */
export function useScreensaverActive(): boolean {
  return useSyncExternalStore(subscribe, getScreensaverActive, () => false);
}
