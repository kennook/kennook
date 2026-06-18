'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useScreensaverIndex } from '@/lib/sync';
import { trpc } from '@/lib/trpc-client';

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
 * Lock: when an admin has set a screensaver passphrase
 * (`screensaverLock.status` → enabled), a dismiss gesture reveals a
 * passphrase prompt instead of exiting; only a server-verified passphrase
 * calls `onExit`. This is a casual-passer-by deterrent, not real security
 * (a browser overlay can always be bypassed by someone with devtools) —
 * full device-trust auth is the planned replacement.
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

  // Lock state. Fetched eagerly (not just while open) so the passphrase
  // requirement is known before the first dismiss gesture.
  const lockStatus = trpc.screensaverLock.status.useQuery(undefined, {
    staleTime: 10_000,
  });
  // FAIL CLOSED: treat the screensaver as locked unless the server has
  // positively told us the lock is OFF (`enabled === false`). While the
  // status is loading or the request errors (e.g. a stale build without the
  // endpoint, or a dropped session), `data` is undefined — and we must NOT
  // let a click dismiss in that window. Safe for genuinely-unlocked
  // instances too: `verify` returns ok for any input when no passphrase is
  // set, so the prompt can't trap anyone.
  const locked = lockStatus.data?.enabled !== false;
  const verify = trpc.screensaverLock.verify.useMutation();

  // Refetch the lock state each time the screensaver opens, so a passphrase
  // set after this tab loaded takes effect on the very next walk-away.
  const refetchLock = lockStatus.refetch;
  useEffect(() => {
    if (open) void refetchLock();
  }, [open, refetchLock]);

  // Passphrase prompt: shown after a dismiss gesture while locked. `lockedRef`
  // lets the window-level capture listeners read the latest value without
  // re-subscribing on every status refetch.
  const [prompting, setPrompting] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [authError, setAuthError] = useState(false);
  // Drives a one-shot shake animation on a wrong passphrase; cleared on
  // animation end so the next wrong attempt can re-trigger it.
  const [shaking, setShaking] = useState(false);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // Reset the prompt whenever the screensaver closes so the next open starts
  // clean (no stale passphrase text / error).
  useEffect(() => {
    if (!open) {
      setPrompting(false);
      setPassphrase('');
      setAuthError(false);
      setShaking(false);
    }
  }, [open]);

  // Focus the field when the prompt appears. rAF so it runs after the input
  // is actually in the DOM (more reliable than the `autoFocus` attribute,
  // which can be missed when the form mounts mid-gesture).
  useEffect(() => {
    if (!prompting) return;
    const raf = requestAnimationFrame(() => promptInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [prompting]);

  const submitPassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (verify.isPending) return;
    const fail = () => {
      setAuthError(true);
      setPassphrase('');
      setShaking(true);
      promptInputRef.current?.focus();
    };
    try {
      const res = await verify.mutateAsync({ password: passphrase });
      if (res.ok) onExit();
      else fail();
    } catch {
      fail();
    }
  };

  // Cancel the prompt → back to the bare screensaver (does NOT dismiss).
  const cancelPrompt = useCallback(() => {
    setPrompting(false);
    setPassphrase('');
    setAuthError(false);
  }, []);

  // Escape cancels the prompt from anywhere — a window-level listener so it
  // works even if focus has left the input. Capture phase + stopPropagation
  // so it doesn't also reach the app underneath.
  useEffect(() => {
    if (!open || !prompting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancelPrompt();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, prompting, cancelPrompt]);

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
  // While the passphrase prompt is up, the listeners stand down so the user
  // can type into / click the form without each keystroke being read as a
  // dismiss gesture. (`prompting` is in the deps so the effect re-runs and
  // detaches when the prompt appears, re-attaches when it's canceled.)
  useEffect(() => {
    if (!open || prompting) return;

    // Locked → a dismiss gesture reveals the prompt instead of exiting.
    // Unlocked → exit immediately, as before.
    const dismiss = () => {
      if (lockedRef.current) setPrompting(true);
      else onExit();
    };

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
  }, [open, prompting, onExit]);

  if (!open || !src) return null;

  return (
    <div className={`fixed inset-0 z-[100] bg-black ${prompting ? '' : 'cursor-none'}`}>
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

      {prompting && (
        <div
          className="absolute inset-0 flex items-center justify-center p-6"
          // Clicking the dimmed area outside the card cancels back to the
          // bare screensaver (does not dismiss).
          onMouseDown={(e) => { if (e.target === e.currentTarget) cancelPrompt(); }}
        >
          <form
            onSubmit={submitPassphrase}
            onAnimationEnd={() => setShaking(false)}
            className={`relative w-full max-w-xs bg-zinc-950/90 backdrop-blur ring-1
                       rounded-xl p-5 flex flex-col gap-3 shadow-2xl
                       ${shaking ? 'kn-shake ring-red-500/50' : 'ring-zinc-800'}`}
          >
            <button
              type="button"
              onClick={cancelPrompt}
              aria-label="Cancel"
              title="Cancel (Esc)"
              className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center
                         rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/10 transition"
            >
              ✕
            </button>

            <div className="text-sm text-zinc-300 text-center pt-1">
              Enter passphrase to unlock
            </div>
            <input
              ref={promptInputRef}
              type="password"
              value={passphrase}
              onChange={(e) => { setPassphrase(e.target.value); setAuthError(false); }}
              placeholder="Passphrase"
              aria-label="Screensaver passphrase"
              className={`bg-zinc-900 border rounded-md px-3 py-2 text-sm outline-none
                          ${authError ? 'border-red-500/70' : 'border-zinc-700 focus:border-zinc-500'}`}
            />
            {authError && (
              <div className="text-xs text-red-400 text-center">Incorrect passphrase</div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={cancelPrompt}
                className="flex-1 bg-zinc-800 text-zinc-200 rounded-md py-2 text-sm font-medium
                           hover:bg-zinc-700 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={verify.isPending || passphrase.length === 0}
                className="flex-1 bg-zinc-200 text-zinc-900 rounded-md py-2 text-sm font-medium
                           hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {verify.isPending ? 'Checking…' : 'Unlock'}
              </button>
            </div>
          </form>
        </div>
      )}
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
