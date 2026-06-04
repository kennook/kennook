'use client';

import { useEffect, useState } from 'react';
import { useScreensaverIndex } from '@/lib/sync';

interface Props {
  open: boolean;
  onExit: () => void;
}

/**
 * Pick a resolution suffix based on the device's physical pixel width
 * (CSS px × devicePixelRatio). Retina laptops get the higher-res asset
 * even though their CSS width is modest. 1080p is the ceiling: the 4K
 * variants were dropped to keep the repo under GitHub's per-file size
 * limits, and 1080p looks fine as ambient screensaver footage even on
 * 5K displays.
 */
function pickHeight(): 720 | 1080 {
  if (typeof window === 'undefined') return 1080;
  const px = window.innerWidth * (window.devicePixelRatio || 1);
  if (px >= 1400) return 1080;
  return 720;
}

/**
 * Lazy manifest cache. Fetched once per session — single small JSON file
 * listing every available screensaver id. Each id has two encoded
 * variants on disk: `<id>-{720,1080}.mp4`.
 */
let manifestPromise: Promise<string[]> | null = null;
function loadManifest(): Promise<string[]> {
  if (!manifestPromise) {
    manifestPromise = fetch('/screensaver/manifest.json')
      .then((r) => r.json() as Promise<string[]>)
      .catch(() => []); // network error / 404 — return empty list
  }
  return manifestPromise;
}

function pickVariantUrl(id: string): string {
  return `/screensaver/${id}-${pickHeight()}.mp4`;
}

// Deliberately understated grade so the footage recedes into the
// background instead of demanding attention. brightness ≈ overall darkness
// (lower = dimmer), contrast at 1 stays neutral (no punchy shadow-deepening),
// saturate < 1 mutes the colors, and a soft blur dissolves fine detail so the
// eye reads it as ambient texture rather than "a video playing". All
// GPU-composited — no runtime cost. Tune to taste; raise brightness or drop
// the blur if it feels too faint.
const SCREENSAVER_FILTER = 'brightness(0.2) contrast(1) saturate(0.8) blur(4px)';

/**
 * Mount once at the page root. Triggered via the `global.screensaver`
 * shortcut from `page.tsx`. Covers everything (z-[100]) and exits on any
 * deliberate user input after a brief arming delay — without the delay,
 * the very mousemove/keyup that came from the launch press would
 * insta-dismiss it.
 *
 * Future: when this becomes lock-protected, the exit listeners route
 * through a passphrase prompt instead of calling onExit directly. That
 * only meaningfully locks in a desktop app — a browser tab can always
 * be closed — so we leave it for the Electron/Tauri milestone.
 */
export function Screensaver({ open, onExit }: Props) {
  // Lazily resolve the video to play on first open. Two pieces of state
  // need to come together first:
  //   - the manifest (fetched on demand, cached for the session)
  //   - the per-tab assigned index (issued by the server via SSE; falls
  //     back to a random number while the SSE connection warms up)
  // The chosen video is then `manifest[assignedIndex % manifest.length]`
  // at the resolution appropriate for this device.
  const [src, setSrc] = useState<string | null>(null);
  const assignedIndex = useScreensaverIndex();

  useEffect(() => {
    if (!open || src) return;
    let cancelled = false;
    void loadManifest().then((manifest) => {
      if (cancelled || manifest.length === 0) return;
      const id = manifest[assignedIndex % manifest.length];
      setSrc(pickVariantUrl(id));
    });
    return () => { cancelled = true; };
  }, [open, src, assignedIndex]);

  // Keep the screen awake while the screensaver is on. Crucial on mobile:
  // a muted video doesn't otherwise prevent the screen from sleeping, and
  // when iOS Safari throttles the page it can drop the SSE stream and miss
  // the cross-device dismiss event. Browsers auto-release the lock on tab
  // hide, so we re-acquire on visibilitychange.
  useEffect(() => {
    if (!open) return;
    type WLSentinel = { release: () => Promise<void> };
    type WLNav = Navigator & { wakeLock?: { request(t: 'screen'): Promise<WLSentinel> } };
    const wl = (navigator as WLNav).wakeLock;
    if (!wl) return;

    let lock: WLSentinel | null = null;
    const acquire = async () => {
      try { lock = await wl.request('screen'); }
      catch { /* user gesture missing, unsupported, denied — silently skip */ }
    };
    void acquire();

    const onVis = () => {
      if (document.visibilityState === 'visible' && open) void acquire();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, [open]);

  // Exit semantics — calibrated against the OS-screensaver mental model:
  //   • Escape / S / click / tap → instant exit (deliberate gestures)
  //   • Mouse movement / scroll  → ignored. A sustained-motion exit
  //                                used to live here but felt too
  //                                twitchy in practice; deliberate
  //                                gestures cover dismissal cleanly.
  //   • Other keys               → ignored, so the user can lean on the
  //                                keyboard without losing the view.
  //
  // Listeners attach in CAPTURE phase on `window` so they run before any
  // bubble-phase `useShortcut` handler elsewhere in the app, and each
  // dismissing event calls `stopPropagation()` so the same Esc / click
  // doesn't also close the underlying viewer or fire other shortcuts.
  // Autorepeat keydowns are ignored — holding `S` to launch shouldn't
  // immediately re-trigger dismissal on the very next autorepeat tick.
  useEffect(() => {
    if (!open) return;

    const dismiss = () => onExit();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === 'Escape' || e.key === 's' || e.key === 'S') {
        e.stopPropagation();
        dismiss();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      e.stopPropagation();
      dismiss();
    };
    const onTouch = (e: TouchEvent) => {
      e.stopPropagation();
      dismiss();
    };

    const captureOpts = { capture: true } as const;
    window.addEventListener('keydown', onKeyDown, captureOpts);
    window.addEventListener('mousedown', onMouseDown, captureOpts);
    window.addEventListener('touchstart', onTouch, { capture: true, passive: true });

    return () => {
      window.removeEventListener('keydown', onKeyDown, captureOpts);
      window.removeEventListener('mousedown', onMouseDown, captureOpts);
      window.removeEventListener('touchstart', onTouch, captureOpts);
    };
  }, [open, onExit]);

  if (!open || !src) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black cursor-none">
      <video
        src={src}
        autoPlay
        muted
        loop
        playsInline
        // scale-105 pushes the soft blurred edge off-screen so the filter
        // doesn't feather a faint black margin at the viewport bounds.
        className="absolute inset-0 w-full h-full object-cover scale-105"
        style={{ filter: SCREENSAVER_FILTER }}
      />
    </div>
  );
}

/**
 * Quietly warms the manifest cache during idle time so the first trigger
 * doesn't pay the cost of a network round trip before it can resolve the
 * variant. We deliberately don't prefetch the actual video here: the
 * assigned index isn't known until the SSE stream delivers it, and
 * prefetching every video on every page load would add tens of MB of
 * bandwidth that most loads would never use.
 */
export function preloadScreensaverInBackground(): () => void {
  if (typeof window === 'undefined') return () => {};
  const fire = () => { void loadManifest(); };

  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  });

  if (typeof ric.requestIdleCallback === 'function') {
    const id = ric.requestIdleCallback(fire, { timeout: 5000 });
    return () => ric.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(fire, 3000);
  return () => window.clearTimeout(t);
}
