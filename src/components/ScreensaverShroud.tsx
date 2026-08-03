'use client';

import { useScreensaverActive } from '@/lib/screensaver-active';

/**
 * Wraps the whole app. While the screensaver is covering the screen, it flips
 * the entire subtree to `visibility: hidden` — a fallback so that if the
 * screensaver overlay is ever removed by some OTHER means (devtools, a video
 * crash, an errant DOM mutation), the private content underneath still isn't
 * exposed. This is more robust than a second cover layer would be: the content
 * is hidden by its own state, not by another element that could be removed the
 * same way. The <Screensaver> root re-asserts `visibility: visible` on itself,
 * so it stays shown while everything else is hidden (a visible descendant beats
 * a hidden ancestor).
 *
 * `display: contents` keeps the wrapper layout-neutral — it generates no box, so
 * the app renders exactly as if this div weren't here; only the inherited
 * `visibility` passes down to the content.
 */
export function ScreensaverShroud({ children }: { children: React.ReactNode }) {
  const active = useScreensaverActive();
  return (
    <div style={{ display: 'contents', visibility: active ? 'hidden' : 'visible' }}>
      {children}
    </div>
  );
}
