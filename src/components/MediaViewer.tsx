'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItemDto } from './MediaGrid';
import { VideoPlayer } from './VideoPlayer';
import { useShortcut, useTapOrHold } from '@/lib/shortcuts';
import { effectiveSensitive } from '@/lib/sensitive-thresholds';
import { likeFillColor } from '@/lib/like-colors';
import { trpc } from '@/lib/trpc-client';
import { ViewerReel } from './ViewerReel';
import { SparkleBurst } from './SparkleBurst';
import { RatingFlash } from './RatingFlash';
import { VoiceTagButton, useVoiceTagger, VoiceTagStatusLine, MicIcon } from './VoiceTagButton';
import { FEATURES } from '@/lib/feature-flags';
import { usePreference } from '@/lib/preferences';
import { ViewportMinimap } from './ViewportMinimap';
import { useSyncEvent } from '@/lib/sync';

const CHROME_IDLE_MS = 2500;

const MAX_LIKES = 5;

// Debounce window for the like action — rapid H presses or clicks during this
// window accumulate into a single server mutation. Long enough to feel
// forgiving (a user tapping H four times still gets one request), short
// enough that a deliberate single press feels responsive.
const LIKE_DEBOUNCE_MS = 500;

// Slideshow timing. Photo display matches the Ken Burns animation duration
// so the zoom plays once through per slide. Fade overlap is short so the
// motion on the new slide isn't washed out by the crossfade.
// Default slideshow per-photo dwell. Overridable by the user via
// `slideshowPhotoMs` preference; constants below cap the adjustable
// range so the slideshow can't be set unusably fast or slow.
const SLIDESHOW_MIN_MS = 2000;
const SLIDESHOW_MAX_MS = 30000;
const SLIDESHOW_STEP_MS = 1000;

interface Props {
  item: MediaItemDto | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onSeeSimilar?: (item: MediaItemDto) => void;
  /** Same handler the grid uses; lets viewer rate without leaving the modal. */
  onSetLikes?: (item: MediaItemDto, count: number) => Promise<void> | void;
  position?: { index: number; total: number };
  /** When true, the viewer is in slideshow mode: identical to the full-screen
   *  view (full manual zoom/pan/fit + video controls), plus auto-advance —
   *  photos after the configured dwell, videos when they reach the end.
   *  Space pauses; Esc exits to the regular viewer. */
  slideshow?: boolean;
  /** Called when Esc is pressed while slideshow is active — exits slideshow
   *  but keeps the viewer open on the current item. */
  onSlideshowExit?: () => void;
  /** If the page is filtering by a person, pass that uuid here so the
   *  viewer can show a "Reassign person" affordance. */
  currentPersonUuid?: string | null;
  /** Called when the user clicks "Reassign person". Parent owns the
   *  dialog so it can mount above this viewer. */
  onReassignPerson?: (item: MediaItemDto) => void;
  /** Persist a rotation override for the current photo (0/90/180/270).
   *  Photo-only — videos handle their own orientation. */
  onRotate?: (item: MediaItemDto, rotation: 0 | 90 | 180 | 270) => void;
  /** Items + cursor + has-more for the "coming up" reel rendered along
   *  the bottom of the maxed viewer. Pass all three together; if any is
   *  missing the reel is silently skipped. */
  reelItems?: MediaItemDto[];
  reelHasMore?: boolean;
  onSelectItem?: (item: MediaItemDto) => void;
  /** Open the "Add to playlist" dialog targeting this item. Parent owns
   *  the dialog so it can mount above the viewer. */
  onAddToPlaylist?: (item: MediaItemDto) => void;
  /** Exclude (soft-delete) this item. Parent owns the confirm dialog +
   *  the advance-to-next/close behavior. */
  onExclude?: (item: MediaItemDto) => void;
  /** Move this item to another library. Tucked under a kebab menu (less
   *  prominent than the primary actions). Parent owns the move dialog +
   *  the advance-to-next/close behavior. */
  onMove?: (item: MediaItemDto) => void;
  /** Set the manual sensitivity override (1 = sensitive, 0 = safe, null =
   *  auto). Also tucked under the kebab. */
  onSetSensitive?: (item: MediaItemDto, override: 0 | 1 | null) => void;
  /** Controlled maxed-mode flag. When BOTH `maxed` and `onMaxedChange`
   *  are provided, the viewer is controlled and the parent owns the
   *  state (typically synced to the URL). When omitted, the viewer
   *  falls back to internal `useState` for backward compatibility. */
  maxed?: boolean;
  onMaxedChange?: (maxed: boolean) => void;
  /** "Post-screensaver quiet": fade chrome to a low-opacity state regardless
   *  of mode. The parent clears it on the first user input. */
  quiet?: boolean;
  /** True while the screensaver overlay is up. Pauses the playing video /
   *  slideshow underneath so it doesn't run unseen, then restores it on
   *  dismiss — but only if it was playing when the screensaver appeared. */
  suspended?: boolean;
  /** Initial seek position in ms for video playback. Forwarded to
   *  VideoPlayer; takes precedence over saved progress on first paint.
   *  Set by search-result clicks on a timestamped text match. */
  initialTimeMs?: number | null;
}

/**
 * Single unified tree for both normal and maxed views. The media element
 * (image or VideoPlayer) is always rendered at the same JSX position, so
 * React keeps it mounted when `maxed` toggles — preserving video playback
 * state (currentTime, paused, muted, etc.) across F-key toggles.
 *
 * Outer container class + sidebar/toolbar visibility flip based on mode.
 */
export function MediaViewer({
  item, onClose, onPrev, onNext, onSeeSimilar, onSetLikes, position,
  slideshow = false, onSlideshowExit,
  currentPersonUuid = null, onReassignPerson,
  onRotate,
  reelItems, reelHasMore, onSelectItem,
  onAddToPlaylist,
  onExclude,
  onMove,
  onSetSensitive,
  maxed: controlledMaxed,
  onMaxedChange,
  quiet = false,
  suspended = false,
  initialTimeMs,
}: Props) {
  // Maxed can be controlled by the parent (preferred — typically synced
  // to the URL) or self-managed via useState (back-compat). Controlled
  // when both `controlledMaxed` and `onMaxedChange` are provided.
  const [internalMaxed, setInternalMaxed] = useState(false);
  const isMaxedControlled = controlledMaxed !== undefined && onMaxedChange !== undefined;
  const maxed = isMaxedControlled ? controlledMaxed : internalMaxed;
  // Ref shadow so `setMaxed`'s function-updater form can read the
  // latest value without recapturing on every render.
  const maxedRef = useRef(maxed);
  maxedRef.current = maxed;
  const setMaxed = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function'
      ? (next as (prev: boolean) => boolean)(maxedRef.current)
      : next;
    if (isMaxedControlled) onMaxedChange!(resolved);
    else setInternalMaxed(resolved);
  }, [isMaxedControlled, onMaxedChange]);

  // Zoom is a single continuous multiplier. 1.0 = "fill" (cover — the image
  // covers the viewport, cropping the overflow). Zooming OUT below 1.0
  // continuously REVEALS the cropped edges until the whole image just fits
  // (contain) at `fitFloorZoom` — the floor, so zoom-out never shrinks the
  // image into a margin-padded box. Zooming IN above 1.0 crops further.
  // `fitFloorZoom` is dynamic (image + viewport aspect); computed below.
  const [zoom, setZoom] = useState(1);
  const MAX_ZOOM = 4;
  // Coarser steps when zooming IN (past 100%); finer 10% steps below 100%
  // where the whole image is visible and small nudges matter more.
  const ZOOM_STEP = 0.25;
  const ZOOM_STEP_FINE = 0.1;

  // Direct percentage entry in the zoom pill. `zoomDraft` holds the raw
  // text while the field is focused; the displayed value falls back to the
  // live zoom otherwise. `zoomCancelRef` lets Escape blur without committing.
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomDraft, setZoomDraft] = useState('');
  const zoomCancelRef = useRef(false);

  // `paused` freezes the slideshow auto-advance timer.
  const [paused, setPaused] = useState(false);

  // Chrome auto-hide in maxed mode: floating buttons + nav arrows + position
  // indicator fade out after ~2.5s of mouse inactivity. Same UX as YouTube
  // / Plex / Apple TV. Reset on any mouse movement.
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);

  // Pan offset in pixels (translate applied to media in maxed + cover mode).
  // Only meaningful when content overflows the viewport (cover fit clips
  // edges). Driven by the corner minimap widget — direct drag-on-content
  // is intentionally disabled so it doesn't fight the video controls.
  // Persisted per asset + orientation in the library DB — see the
  // `mediaView` tRPC router and the `savedView` query below.
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // Intentionally do NOT reset `maxed`/`fit` when `item` briefly becomes null.
  // During cross-page navigation the parent may flicker `item` to null for a
  // single render between pages; resetting would kick the user out of
  // fullscreen mid-transition. Users exit fullscreen explicitly via Esc/F.

  // Resize trigger: derived geometry (bounds, minimap layout) reads
  // window.innerWidth/Height during render. Without this, a window
  // resize wouldn't re-render the viewer and the minimap rectangle
  // would lag the actual visible region until something else triggered
  // a render.
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setResizeTick((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Viewport orientation selects WHICH saved framing we read/write, so a
  // portrait phone and a landscape display keep separate pan/zoom for the
  // same asset rather than overwriting each other. Recomputed every render —
  // resizeTick re-renders on rotation, so this tracks the live viewport.
  const orientation: 'portrait' | 'landscape' =
    typeof window !== 'undefined' && window.innerHeight > window.innerWidth
      ? 'portrait'
      : 'landscape';
  const orientationRef = useRef(orientation);
  orientationRef.current = orientation;

  // Continuous-zoom reference points, dependent on image vs viewport aspect:
  //   coverRatio   = how much bigger "fill" (cover) is than "fit" (contain).
  //   fitFloorZoom = 1/coverRatio = the zoom at which the WHOLE image just
  //                  fits — the zoom-OUT floor. Below it the image would only
  //                  gain empty margins, which we don't want.
  // Matching-aspect images have coverRatio 1 (cover == contain): nothing to
  // reveal, so zoom-out is effectively disabled. resizeTick re-renders on
  // viewport change so this tracks the live geometry.
  const coverRatio = (() => {
    const w = item?.width ?? 0;
    const h = item?.height ?? 0;
    if (typeof window === 'undefined' || w <= 0 || h <= 0) return 1;
    const contentRatio = w / h;
    const viewportRatio = window.innerWidth / Math.max(1, window.innerHeight);
    return Math.max(contentRatio / viewportRatio, viewportRatio / contentRatio);
  })();
  const fitFloorZoom = coverRatio > 0 ? 1 / coverRatio : 1;

  // Saved framing for the current item + orientation, read from the asset's
  // own library DB (shared across clients). Replaces the old per-browser
  // localStorage memory. One tiny single-row fetch per viewed item.
  // staleTime 0 + refetch-on-focus: with an asset-level, multi-client value
  // we never want to render a stale framing. The `mediaView.changed` sync
  // event (below) also invalidates this key when another client writes.
  const savedView = trpc.mediaView.get.useQuery(
    { librarySlug: item?.librarySlug ?? '', uuid: item?.uuid ?? '', orientation },
    { enabled: !!item, staleTime: 0, refetchOnWindowFocus: true },
  );
  const viewUtils = trpc.useUtils();
  const { mutateAsync: setView } = trpc.mediaView.set.useMutation();

  // OCC version (ETag) the next write is based on. Seeded from the restore
  // effect and updated on every successful write / conflict convergence.
  const viewVersionRef = useRef(0);
  // Serializes writes so rapid same-tab commits (e.g. holding zoom) don't
  // conflict with each other — only cross-CLIENT writes hit the OCC path.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

  // Persist on user-initiated commits only (zoom press / pan release), never
  // per frame. Version-guarded: if a concurrent client moved the row on, we
  // converge to their value, then re-apply this gesture on the fresh base
  // (active gesture wins) — bounded to one retry so two clients can't loop.
  const persistView = useCallback((x: number, y: number, zoomVal: number) => {
    if (!item) return;
    const key = {
      librarySlug: item.librarySlug,
      uuid: item.uuid,
      orientation: orientationRef.current,
    };
    const base = viewVersionRef.current; // capture before the optimistic write
    // Optimistic local cache so navigating back within the session is instant.
    viewUtils.mediaView.get.setData(key, { x, y, zoom: zoomVal, version: base + 1 });

    const run = async () => {
      let baseVersion = base;
      for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
          res = await setView({ ...key, x, y, zoom: zoomVal, fit: 'cover', baseVersion });
        } catch {
          return; // network error — keep optimistic value; reconciles on next fetch
        }
        if (res.ok && res.row) {
          viewVersionRef.current = res.row.version;
          viewUtils.mediaView.get.setData(key, res.row);
          return;
        }
        if (res.conflict) {
          // Converge to the server's current value, then retry on top of it.
          viewUtils.mediaView.get.setData(key, res.row);
          baseVersion = res.row?.version ?? 0;
          viewVersionRef.current = baseVersion;
          continue;
        }
        return; // !ok && !conflict (e.g. item missing) — nothing to do
      }
    };
    writeChainRef.current = writeChainRef.current.then(run, run);
  }, [item, setView, viewUtils]);

  // Another client changed this asset's framing → refresh the key's cache so
  // the NEXT open is fresh. We deliberately don't jump the currently-open
  // view (the restore-once guard below keeps it stable).
  useSyncEvent('mediaView.changed', (e) => {
    void viewUtils.mediaView.get.invalidate({
      librarySlug: e.librarySlug, uuid: e.uuid, orientation: e.orientation,
    });
  });

  // Cover-fit pixel dimensions of the current item plus pan limits.
  //   cw, ch    = image dimensions when rendered with `object-fit: cover`
  //               (baseline; zoom multiplies the visual rendering).
  //   maxX, maxY = pan limits in cover-pixel units. At zoom 1 this is
  //               just the cover-overflow on each axis (one is usually
  //               zero for non-matching aspect ratios). At zoom > 1 the
  //               limit grows on BOTH axes because the scaled image
  //               now overflows in both directions — the user can pan
  //               into the dimension that previously had no overflow.
  //
  //   formula: maxX = (cw·zoom − vw) / (2·zoom) cover-pixels
  //     • At zoom 1: (cw − vw) / 2 = pure cover-overflow.
  //     • At zoom 2: (2cw − vw) / 4, strictly larger than zoom-1 limit.
  //     • The `/ (2·zoom)` converts viewport-pixels of overflow back
  //       into cover-pixels (1 cover-pixel = `zoom` viewport-pixels
  //       after the CSS scale transform).
  const computeBounds = useCallback(() => {
    if (!item || !item.width || !item.height || typeof window === 'undefined') {
      return { maxX: 0, maxY: 0, cw: 0, ch: 0, vw: 0, vh: 0 };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const contentRatio = item.width / item.height;
    const viewportRatio = vw / vh;
    let cw: number; let ch: number;
    if (contentRatio > viewportRatio) {
      ch = vh;
      cw = ch * contentRatio;
    } else {
      cw = vw;
      ch = cw / contentRatio;
    }
    return {
      maxX: Math.max(0, (cw * zoom - vw) / (2 * zoom)),
      maxY: Math.max(0, (ch * zoom - vh) / (2 * zoom)),
      cw, ch, vw, vh,
    };
    // resizeTick + zoom intentionally included so consumers recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, resizeTick, zoom]);

  // Restore the saved pan offset for this item (or reset to (0,0) when none).
  // Zoom always resets to 1.0 on item change — each item starts at its
  // natural fit framing. Pan is persisted across navigation and reloads
  // so returning to a previously-panned item lands you on the same framing.
  //
  // Gated on a uuid-change ref because `item` itself can be replaced by a
  // new object after a refetch (e.g., a like mutation invalidates queries);
  // without this guard, an in-progress pan drag could be snapped back to
  // the saved value mid-gesture.
  const lastPanUuidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!item) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      viewVersionRef.current = 0;
      lastPanUuidRef.current = null;
      return;
    }
    if (lastPanUuidRef.current === item.uuid) return;
    // The saved framing now loads async (DB-backed). Wait for it to resolve
    // for THIS item before applying — otherwise we'd snap to default and
    // never re-apply once the value arrives.
    if (savedView.isLoading) return;
    lastPanUuidRef.current = item.uuid;
    const saved = savedView.data;
    if (!saved) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      viewVersionRef.current = 0;
      return;
    }
    viewVersionRef.current = saved.version; // seed the OCC base from this read
    // Clamp into the current floor — the saved zoom may have come from a
    // slightly different viewport size in the same orientation.
    setZoom(Math.max(fitFloorZoom, Math.min(MAX_ZOOM, saved.zoom)));
    // Pan limits depend on zoom; computeBounds reads the current zoom
    // state which hasn't flushed yet, so recompute manually with the
    // saved zoom to clamp the restored pan correctly.
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
    const r = (item.width ?? 1) / (item.height ?? 1);
    const vr = vw / (vh || 1);
    const cw = r > vr ? vh * r : vw;
    const ch = r > vr ? vh : vw / r;
    const maxX = Math.max(0, (cw * saved.zoom - vw) / (2 * saved.zoom));
    const maxY = Math.max(0, (ch * saved.zoom - vh) / (2 * saved.zoom));
    setPan({
      x: Math.max(-maxX, Math.min(maxX, saved.x)),
      y: Math.max(-maxY, Math.min(maxY, saved.y)),
    });
  }, [item, savedView.isLoading, savedView.data]);

  // Pan is meaningful whenever the displayed image overflows the viewport —
  // which can happen in the reveal range too (e.g. a portrait below 100%
  // still overflows vertically). The actual pan limits come from
  // computeBounds (0 when there's no overflow), so this just needs `maxed`.
  const isPanEnabled = maxed;

  // Re-clamp pan whenever zoom changes — the bounds grew (zoom in)
  // or shrunk (zoom out), so a previously-valid pan may now be out of
  // range. Return the same ref when unchanged to avoid render churn.
  useEffect(() => {
    const { maxX, maxY } = computeBounds();
    setPan((p) => {
      const nx = Math.max(-maxX, Math.min(maxX, p.x));
      const ny = Math.max(-maxY, Math.min(maxY, p.y));
      return (nx === p.x && ny === p.y) ? p : { x: nx, y: ny };
    });
  }, [zoom, computeBounds]);

  // Zoom mutators. Clamp into [fitFloorZoom, MAX_ZOOM]. The floor is the
  // whole-image-fits point, so you can reveal everything but never shrink
  // past it into empty margins.
  const clampZoom = useCallback((z: number) =>
    Math.max(fitFloorZoom, Math.min(MAX_ZOOM, z)), [fitFloorZoom]);

  // panRef lets persist helpers read the latest pan without dragging
  // it into useCallback deps (which would re-create them on every
  // pan tick — wasteful).
  const panRef = useRef(pan);
  panRef.current = pan;

  // Tracks the previous render's fill-vs-reveal mode so we can suppress the
  // transform transition on the single frame that crosses the 100% boundary
  // (see `fitBoundaryCrossed` in the render body).
  const prevRenderContainRef = useRef(false);

  // Persist the current view (pan + new zoom) for this item. Called
  // from user-initiated zoom changes; not from the restore effect
  // (which loaded the value in the first place). Persists in slideshow
  // too now — it uses the full-screen view, so zoom/pan behaves identically.
  const persistZoom = useCallback((newZoom: number) => {
    persistView(panRef.current.x, panRef.current.y, newZoom);
  }, [persistView]);

  // #5 (single-client load race): the moment the user changes zoom/pan, claim
  // this item's restore slot so a still-loading saved value can't snap their
  // adjustment back when it arrives.
  const markInteracted = useCallback(() => {
    if (item) lastPanUuidRef.current = item.uuid;
  }, [item]);

  // Fit/Fill snap (the "C" key + the pill/minimap button). If we're showing
  // the whole image (at/near the floor), jump to fill (100%); otherwise jump
  // to the floor (whole image). Either way recenter pan.
  const toggleFitFill = useCallback(() => {
    markInteracted();
    const target = zoom <= fitFloorZoom + 0.01 ? 1 : fitFloorZoom;
    setZoom(target);
    setPan({ x: 0, y: 0 });
    persistView(0, 0, target);
  }, [zoom, fitFloorZoom, persistView, markInteracted]);

  const zoomIn = useCallback(() => {
    markInteracted();
    setZoom((z) => {
      const next = clampZoom(z + (z < 1 ? ZOOM_STEP_FINE : ZOOM_STEP));
      if (next !== z) persistZoom(next);
      return next;
    });
  }, [clampZoom, persistZoom, markInteracted]);
  const zoomOut = useCallback(() => {
    markInteracted();
    setZoom((z) => {
      const next = clampZoom(z - (z <= 1 ? ZOOM_STEP_FINE : ZOOM_STEP));
      if (next !== z) persistZoom(next);
      return next;
    });
  }, [clampZoom, persistZoom, markInteracted]);

  // Apply a typed percentage (e.g. "150" → 1.5), clamped to the zoom range.
  const applyZoomPercent = useCallback((raw: string) => {
    const pct = Number(raw.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(pct) || pct <= 0) return;
    markInteracted();
    const next = clampZoom(pct / 100);
    setZoom(next);
    persistZoom(next);
  }, [clampZoom, persistZoom, markInteracted]);

  // ── Slideshow effects ───────────────────────────────────────────────
  //
  // 1) Slideshow → un-pause auto-advance. Fullscreen is owned by the caller
  //    (page-level startSlideshow sets `view=full` in the same url.set call
  //    that opens the item). Calling setMaxed(true) here used to race the
  //    parent's url.set: this effect fires on the first commit when the
  //    parent's URL transition hasn't propagated yet, so url.set runs with
  //    a stale searchParams base and wipes the just-written item param.
  useEffect(() => {
    if (slideshow) {
      setPaused(false);
    }
  }, [slideshow]);

  // Auto-advance for photos. Videos advance via onEnded; this timer is
  //    photo-only. Pause stops scheduling. Duration is the user's
  //    slideshow preference (adjustable via , / . in slideshow mode).
  const [slideshowPhotoMs, setSlideshowPhotoMs] = usePreference('slideshowPhotoMs');
  useEffect(() => {
    if (!slideshow || paused || !item) return;
    if (item.kind !== 'photo') return;
    if (!onNext) return;
    const t = window.setTimeout(() => onNext(), slideshowPhotoMs);
    return () => window.clearTimeout(t);
  }, [item, slideshow, paused, onNext, slideshowPhotoMs]);

  // 4) Screensaver suspend. While the screensaver is up, freeze the slideshow
  //    auto-advance (Ken Burns + photo timer) so it doesn't run unseen. On
  //    dismiss, resume only if it was playing when the screensaver appeared —
  //    a manual pause is preserved. Videos pause via VideoPlayer.forcePaused.
  //    Keyed on `suspended` alone; `paused` is sampled at the transition (the
  //    user can't toggle it while the screensaver captures all input).
  const slideshowResumeRef = useRef(false);
  useEffect(() => {
    if (!slideshow) return;
    if (suspended) {
      slideshowResumeRef.current = !paused;
      setPaused(true);
    } else if (slideshowResumeRef.current) {
      slideshowResumeRef.current = false;
      setPaused(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended, slideshow]);

  // Brief overlay shown when the user adjusts slideshow speed.
  // Incrementing the key re-mounts the indicator so its fade-out
  // animation re-plays on every adjustment.
  const [speedNotice, setSpeedNotice] = useState<{ key: number; ms: number } | null>(null);
  useEffect(() => {
    if (!speedNotice) return;
    const t = window.setTimeout(() => setSpeedNotice(null), 1500);
    return () => window.clearTimeout(t);
  }, [speedNotice]);

  const adjustSlideshowSpeed = useCallback((deltaMs: number) => {
    const next = Math.max(
      SLIDESHOW_MIN_MS,
      Math.min(SLIDESHOW_MAX_MS, slideshowPhotoMs + deltaMs),
    );
    if (next === slideshowPhotoMs) return;
    setSlideshowPhotoMs(next);
    setSpeedNotice({ key: Date.now(), ms: next });
  }, [slideshowPhotoMs, setSlideshowPhotoMs]);

  // Whenever we leave maxed mode (or the viewer closes), drop any pending
  // idle timer and show all chrome.
  useEffect(() => {
    if (!maxed) {
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setChromeVisible(true);
    } else {
      // Entering maxed: show chrome immediately, then start the idle timer.
      setChromeVisible(true);
      idleTimerRef.current = window.setTimeout(
        () => setChromeVisible(false),
        CHROME_IDLE_MS,
      );
    }
    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [maxed]);

  // While the cursor is over any chrome element, the idle timer is
  // suspended — fading the controls out from under the user's pointer
  // looks like a bug. Tracked via a ref so the chrome-hover handlers
  // can read/write it without triggering renders.
  const chromeHoveredRef = useRef(false);

  // Show chrome and (re-)arm the idle timer. Used by both mouse movement
  // and by shortcut handlers — pressing a key in fullscreen now reveals
  // the chrome briefly so the user sees the effect of their action. If
  // the cursor is over chrome, we show but DON'T start the timer (the
  // mouseleave handler restarts it when the cursor exits).
  const pulseChrome = useCallback(() => {
    if (!maxed) return;
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    setChromeVisible(true);
    if (chromeHoveredRef.current) return;
    idleTimerRef.current = window.setTimeout(
      () => setChromeVisible(false),
      CHROME_IDLE_MS,
    );
  }, [maxed]);

  // Handlers spread onto every chrome wrapper so the idle timer
  // suspends/resumes correctly as the cursor enters/leaves controls. The
  // `data-kn-chrome` marker lets the root mouse-move handler below tell,
  // authoritatively, whether the cursor is over chrome.
  const chromeHoverHandlers = {
    'data-kn-chrome': '',
    onMouseEnter: () => {
      chromeHoveredRef.current = true;
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setChromeVisible(true);
    },
    onMouseLeave: () => {
      chromeHoveredRef.current = false;
      pulseChrome();
    },
  };

  // Root mouse-move: re-derive the hover flag from the element actually
  // under the cursor, THEN pulse. Enter/leave bookkeeping alone gets stuck
  // `true` when a hovered control unmounts (e.g. a nav arrow disabling at
  // the first/last item) or re-renders without firing `onMouseLeave` —
  // which leaves `pulseChrome` permanently short-circuited and the chrome
  // pinned on screen. Recomputing from the real target on each move
  // self-heals that the instant the cursor moves.
  const handleViewerMouseMove = useCallback((e: React.MouseEvent) => {
    if (maxed) {
      const target = e.target as Element | null;
      chromeHoveredRef.current = !!target?.closest?.('[data-kn-chrome]');
    }
    pulseChrome();
  }, [maxed, pulseChrome]);

  // Minimap drives pan: continuous updates during drag, final commit on
  // release. We persist on commit, not on every move, to keep
  // localStorage writes off the hot path. The `panDragging` flag turns
  // off the object-position transition during drag — otherwise the
  // rendered content would lag the minimap rectangle.
  const [panDragging, setPanDragging] = useState(false);
  const handleMinimapPan = useCallback((next: { x: number; y: number }) => {
    markInteracted(); // claim the restore slot at drag start
    setPan(next);
    setPanDragging(true);
  }, [markInteracted]);
  const handleMinimapCommit = useCallback((final: { x: number; y: number }) => {
    setPanDragging(false);
    persistView(final.x, final.y, zoom);
  }, [persistView, zoom]);

  // Step-down "back" handler. Used by both the Esc shortcut and the
  // top-right X button so they behave identically:
  //   slideshow → exit slideshow (keep viewer on current item)
  //   maxed     → un-maximize (drop back to the preview modal)
  //   preview   → close the viewer entirely
  // A second press repeats the same logic at the next level.
  const handleStepBack = useCallback(() => {
    if (slideshow) { onSlideshowExit?.(); return; }
    if (maxed) { setMaxed(false); return; }
    onClose();
  }, [slideshow, maxed, onSlideshowExit, setMaxed, onClose]);

  useShortcut('viewer.close', handleStepBack, { enabled: !!item });

  // Space toggles pause when the slide is a photo. For videos we let
  // VideoPlayer's own Space handler pause playback (pausing the video
  // naturally stops the slideshow from advancing past it).
  useShortcut(
    'video.playPause',
    (e) => { e.preventDefault(); setPaused((v) => !v); pulseChrome(); },
    { enabled: !!item && slideshow && item?.kind === 'photo' },
  );

  useShortcut('viewer.maximize', () => setMaxed((v) => !v), { enabled: !!item });

  useShortcut('viewer.fitToggle', () => {
    if (maxed) {
      toggleFitFill();
      pulseChrome();
    }
  }, { enabled: !!item && maxed });
  useShortcut('viewer.zoomIn', () => {
    if (maxed) { zoomIn(); pulseChrome(); }
  }, { enabled: !!item && maxed });
  useShortcut('viewer.zoomOut', () => {
    if (maxed) { zoomOut(); pulseChrome(); }
  }, { enabled: !!item && maxed });
  // Slideshow speed adjust — only active when slideshow is on. `,`
  // slows down (more time per photo), `.` speeds up (less time).
  useShortcut('viewer.slideshowSlower', () => {
    adjustSlideshowSpeed(SLIDESHOW_STEP_MS);
  }, { enabled: !!item && slideshow });
  useShortcut('viewer.slideshowFaster', () => {
    adjustSlideshowSpeed(-SLIDESHOW_STEP_MS);
  }, { enabled: !!item && slideshow });

  // Up/Down navigates between items regardless of kind. Left/Right are
  // now reserved for video seek (handled inside VideoPlayer); for a
  // photo, those keys do nothing.
  useShortcut('nav.prevItem', () => { onPrev?.(); pulseChrome(); }, { enabled: !!item && !!onPrev });
  useShortcut('nav.nextItem', () => { onNext?.(); pulseChrome(); }, { enabled: !!item && !!onNext });

  // ── Debounced like state ────────────────────────────────────────────
  //
  // Both the H shortcut and the heart-button click(s) drive the SAME
  // optimistic counter. Rapid bumps update the optimistic value immediately
  // and (re-)arm a single debounce timer; only the final value is sent to
  // the server. This lets the user tap H four times for "really likes" and
  // get one request, not four — and also fixes a latent bug where each tap
  // recomputed `next` from the stale `item.likeCount` and stuck at +1.
  const [pendingLikes, setPendingLikes] = useState<number | null>(null);
  const likeTimerRef = useRef<number | null>(null);
  // Captured so the timer/flush-on-leave fires against the right item even
  // if `item` changes (or goes null) before the debounce window elapses.
  const pendingItemRef = useRef<MediaItemDto | null>(null);
  // Sparkle bursts use leading-edge debounce on the SAME window as the
  // mutation: the FIRST bump in a rate-burst fires the visual; subsequent
  // bumps inside the window are suppressed (rapid taps still register as
  // likes, they just don't stack confetti on top of each other). One burst
  // per "I'm rating this" gesture.
  const [sparkleKey, setSparkleKey] = useState(0);
  const lastSparkleAtRef = useRef(0);

  const displayLikes = pendingLikes ?? item?.likeCount ?? 0;

  const bumpLikes = useCallback(() => {
    if (!item || !onSetLikes) return;
    const target = item;
    setPendingLikes((curr) => {
      const base = curr ?? target.likeCount;
      const next = base >= MAX_LIKES ? 0 : base + 1;
      pendingItemRef.current = target;
      if (likeTimerRef.current) window.clearTimeout(likeTimerRef.current);
      likeTimerRef.current = window.setTimeout(() => {
        likeTimerRef.current = null;
        void onSetLikes(target, next);
      }, LIKE_DEBOUNCE_MS);
      return next;
    });
    const now = Date.now();
    if (now - lastSparkleAtRef.current > LIKE_DEBOUNCE_MS) {
      lastSparkleAtRef.current = now;
      setSparkleKey((k) => k + 1);
    }
    pulseChrome();
  }, [item, onSetLikes, pulseChrome]);

  // Clear the optimistic overlay once the server count catches up — then
  // subsequent bumps base off the real value again.
  useEffect(() => {
    if (pendingLikes !== null && item && pendingLikes === item.likeCount) {
      setPendingLikes(null);
    }
  }, [item?.likeCount, item, pendingLikes]);

  // If the user navigates to a different item with un-committed bumps, flush
  // the pending value for the OLD item immediately so their intent isn't
  // lost, then reset for the new item.
  const lastItemUuidRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prevUuid = lastItemUuidRef.current;
    const nextUuid = item?.uuid;
    if (prevUuid !== undefined && prevUuid !== nextUuid) {
      if (likeTimerRef.current !== null) {
        window.clearTimeout(likeTimerRef.current);
        likeTimerRef.current = null;
        const target = pendingItemRef.current;
        if (target && pendingLikes !== null && onSetLikes) {
          void onSetLikes(target, pendingLikes);
        }
      }
      setPendingLikes(null);
      pendingItemRef.current = null;
    }
    lastItemUuidRef.current = nextUuid;
  }, [item?.uuid, pendingLikes, onSetLikes]);

  useShortcut('viewer.like', bumpLikes, { enabled: !!item && !!onSetLikes });

  // ── Mark viewed on viewer open ───────────────────────────────────────
  //
  // Opening an item in the viewer counts as an interaction (per the
  // watched/unwatched filter). Deduped per-session so paging quickly
  // through 60 items doesn't fire 60 mutations on every re-render.
  // We intentionally do NOT invalidate the list query on success — if the
  // user is filtering by "unwatched", that would yank the currently-shown
  // item out from under them. The list refreshes on next navigation.
  const { mutate: markViewedMutate } = trpc.media.markViewed.useMutation();
  const viewedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!item) return;
    const key = `${item.librarySlug}:${item.uuid}`;
    if (viewedRef.current.has(key)) return;
    viewedRef.current.add(key);
    markViewedMutate({ uuid: item.uuid, librarySlug: item.librarySlug });
  }, [item?.uuid, item?.librarySlug, markViewedMutate]);

  // Maxed-mode voice tagger. Separate instance from the sidebar
  // VoiceTagButton's hook — the two are never both interacted with at
  // once (sidebar lives in non-maxed; toolbar + shortcut in maxed). We
  // pass empty fallback strings so the hook can be unconditionally
  // called even before `item` is defined; `start()` is gated by the
  // shortcut/button being enabled, which both require `item`.
  const utils = trpc.useUtils();
  const maxedVoiceTagger = useVoiceTagger({
    uuid: item?.uuid ?? '',
    librarySlug: item?.librarySlug ?? '',
    onCommitted: (tags) => {
      if (tags.length > 0) {
        utils.media.getDetails.invalidate();
        utils.media.facets.invalidate();
      }
    },
  });

  // V (held) → record; release → commit. Only active in maxed mode to
  // avoid stealing the key from grid navigation. The hold threshold is
  // very short (1ms via the tap suppression below) — for a hold-to-do
  // shortcut we don't want a tap fallback.
  useTapOrHold('viewer.voiceTag', {
    enabled: FEATURES.voiceTagging && !!item && maxed,
    holdThresholdMs: 1,
    onHoldStart: () => maxedVoiceTagger.start(),
    onHoldEnd: () => maxedVoiceTagger.stop(),
  });

  if (!item) return null;

  // Continuous fill↔reveal, no discontinuity at 100%:
  //   • zoom >= 1 ("fill" and in): render object-cover and scale by `zoom`
  //     exactly as before — the cover pan machinery below is untouched.
  //   • zoom < 1 (reveal): render object-CONTAIN, but scale it UP by
  //     `zoom * coverRatio`. At zoom→1⁻ that scale → coverRatio, which makes
  //     the contained image exactly the size of the cover image — so it lines
  //     up seamlessly with the cover render at the boundary (no jump). As zoom
  //     drops to fitFloorZoom the scale → 1, i.e. the whole image at contain
  //     size. Pan is off here (the image fits), so this is a pure scale.
  const renderContain = zoom < 1;
  const fitClass = renderContain ? 'object-contain' : 'object-cover';
  const effScale = renderContain ? zoom * coverRatio : zoom;
  // Crossing the 100% boundary swaps object-fit (cover↔contain) instantly
  // while the transform would animate — which flickers (shrink-then-grow),
  // because the two render modes have different base sizes. The sizes MATCH
  // exactly at the boundary, so skip the transition on just that frame: the
  // step applies instantly and seamlessly.
  const fitBoundaryCrossed = prevRenderContainRef.current !== renderContain;
  prevRenderContainRef.current = renderContain;
  const viewTransition = (panDragging || fitBoundaryCrossed)
    ? undefined
    : 'object-position 200ms, transform 200ms';

  const panBounds = computeBounds();

  // ── Pan model (hybrid at zoom > 1) ─────────────────────────────────
  //
  // Pan state is stored in cover-pixel units. Two CSS mechanisms apply
  // it in parallel:
  //
  //   • object-position shifts the cover-fit slice WITHIN the image
  //     element. Its range is bounded by the cover-overflow at zoom 1
  //     (= (cw − vw)/2 cover-pixels on each axis). For images whose
  //     aspect matches one viewport dimension exactly, the limit on
  //     that axis is zero.
  //
  //   • transform: translate moves the entire (scaled) element within
  //     the wrapper. Used for pan that goes BEYOND the cover-overflow
  //     range — only possible at zoom > 1, where the scaled element
  //     overflows in both dimensions.
  //
  // Total pan = the object-position-bounded chunk PLUS any excess that
  // goes into translate. At zoom 1 the translate component is always
  // zero (because excess pan is impossible — bounds collapse to
  // cover-overflow).
  // object-position can absorb pan ONLY in the cover render (zoom >= 1). On
  // object-contain (the reveal range) it does nothing, so there we set the
  // object-position capacity to 0 and route ALL pan through translate.
  const maxObjX = renderContain ? 0 : Math.max(0, (panBounds.cw - panBounds.vw) / 2);
  const maxObjY = renderContain ? 0 : Math.max(0, (panBounds.ch - panBounds.vh) / 2);
  const panObjX = Math.max(-maxObjX, Math.min(maxObjX, pan.x));
  const panObjY = Math.max(-maxObjY, Math.min(maxObjY, pan.y));
  // Translate carries the rest. 1 cover-pixel = `zoom` screen px (the
  // displayed image is cw*zoom wide in BOTH render modes), so multiply by
  // zoom. In the reveal range panObj is 0, so all of `pan` lands here.
  const panTransX = (pan.x - panObjX) * zoom;
  const panTransY = (pan.y - panObjY) * zoom;

  const opX = maxObjX > 0 ? 50 * (1 - panObjX / maxObjX) : 50;
  const opY = maxObjY > 0 ? 50 * (1 - panObjY / maxObjY) : 50;
  // object-position is a no-op on object-contain, so only emit it for cover.
  const objectPosition = (!renderContain && isPanEnabled) ? `${opX}% ${opY}%` : undefined;

  // Wrapper has overflow-hidden so the scaled/translated element clips at the
  // viewport bounds. Translate now applies in BOTH render modes.
  const zoomActive = maxed && effScale !== 1;
  const translateActive = panTransX !== 0 || panTransY !== 0;
  const translatePart = translateActive
    ? `translate(${panTransX}px, ${panTransY}px) `
    : '';

  // Class fragment applied to every chrome element. Three states:
  //   • quiet (post-screensaver): fade to ~30% in both modes; non-interactive
  //     until the parent clears the flag on first user input.
  //   • maxed: fade in/out via the existing idle timer.
  //   • else: always visible.
  // `will-change-[opacity]` pre-promotes each chrome element to its own GPU
  // layer so the opacity transitions are cheap composite operations instead of
  // CPU paints — the biggest perf lever on slower hardware. Pure CSS hint, no
  // layout cost when chrome is at rest.
  const chromeFadeClass = quiet
    ? 'transition-opacity duration-500 opacity-30 pointer-events-none will-change-[opacity]'
    : maxed
      ? `transition-opacity duration-300 will-change-[opacity] ${chromeVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`
      : '';

  return (
    <div
      className={maxed
        ? `fixed inset-0 z-50 bg-black ${chromeVisible ? '' : 'cursor-none'}`
        : 'fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-4'}
      // Only close on direct backdrop clicks — child floating chrome
      // (top-right toolbar, nav arrows, position indicator) sit outside
      // the middle wrapper, so without this guard their clicks bubble
      // up here and would close the viewer unintentionally.
      onClick={maxed ? undefined : (e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onMouseMove={handleViewerMouseMove}
    >
      {/* ── Media area — single mounted instance across modes ────────── */}
      <div
        className={maxed
          ? 'absolute inset-0'
          : 'flex-1 flex items-center justify-center min-h-0 relative group max-w-7xl w-full h-full max-h-[92vh] flex-row'}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Pan lives in the corner minimap; the actual visual shift
            happens via `object-position` on the inner media element.
            `overflow-hidden` here clips the media when zoom > 1 so the
            scaled-up element doesn't bleed outside the viewport.
            `self-stretch min-h-0` in non-maxed bounds the wrapper to
            the parent's height — otherwise tall (portrait) images
            grow the wrapper past the modal, pushing absolutely-
            positioned chrome (e.g. the maximize button) off-screen. */}
        <div
          className={maxed
            ? 'absolute inset-0 overflow-hidden'
            : 'flex-1 self-stretch flex items-center justify-center min-h-0 relative group'}
        >
          {item.kind === 'photo' ? (
            <img
              src={item.previewUrl}
              alt={item.filename}
              draggable={false}
              className={maxed
                ? `w-full h-full ${fitClass} select-none`
                : 'max-h-full max-w-full object-contain rounded'}
              style={{
                ['--kn-rotation' as string]: `${item.rotation ?? 0}deg`,
                objectPosition,
                transform: zoomActive || translateActive
                  ? `${translatePart}rotate(var(--kn-rotation)) scale(${effScale})`
                  : 'rotate(var(--kn-rotation))',
                transition: viewTransition,
                ['WebkitUserDrag' as string]: 'none',
                ['userDrag' as string]: 'none',
              } as React.CSSProperties}
            />
          ) : (
            <VideoPlayer
              src={item.mediaUrl}
              progressKey={`${item.librarySlug}:${item.uuid}`}
              initialTimeMs={initialTimeMs}
              forcePaused={suspended}
              className={maxed
                ? 'w-full h-full overflow-hidden'
                : 'max-h-full max-w-full rounded overflow-hidden bg-black'}
              videoClassName={maxed
                ? `w-full h-full ${fitClass}`
                : 'max-h-[88vh] max-w-full'}
              videoStyle={{
                objectPosition,
                transform: (zoomActive || translateActive)
                  ? `${translatePart}scale(${effScale})`
                  : undefined,
                transition: viewTransition,
              }}
              onPrev={onPrev}
              onNext={onNext}
              // Pause respects: if user paused the slideshow during a
              // video, end-of-video does NOT auto-advance to next.
              onEnded={slideshow && !paused ? onNext : undefined}
              // Scale the bottom controls bar on large displays, but only
              // in maxed mode — the preview-modal video stays compact.
              scaled={maxed}
            />
          )}

          {!maxed && (
            <ToolbarButton
              onClick={() => setMaxed(true)}
              title="Maximize — F"
              className="absolute top-3 right-3 z-30 ring-1 ring-zinc-700/80"
            >
              <MaximizeIcon />
            </ToolbarButton>
          )}

          {/* Brief rating chip that appears each time a new asset loads.
              `key={item.uuid}` makes it re-mount (and the CSS animation
              re-fire) on item change. Renders for unrated items too, in
              a dimmed/zinc variant — hints "this is rateable" without
              shouting like the full-color rose version. */}
          <div
            key={`rating-flash-${item.uuid}`}
            className="absolute top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none"
          >
            <RatingFlash count={displayLikes} />
          </div>

          {/* Slideshow speed feedback. Pops in for ~1.5s after the
              user adjusts via , / . — the key changes with each
              adjustment so React re-mounts the element and the
              animation re-plays. */}
          {speedNotice && (
            <div
              key={speedNotice.key}
              className="absolute top-16 left-1/2 z-30 pointer-events-none
                         bg-black/90 text-zinc-100 text-sm font-medium
                         rounded-full px-4 py-2 ring-1 ring-zinc-700 kn-speed-notice"
            >
              Slideshow: {(speedNotice.ms / 1000).toFixed(0)} s / photo
            </div>
          )}

          {/* Pan + zoom widget — both controls live together because
              they're the same gesture conceptually (re-framing). Zoom
              row is always visible in maxed mode; the minimap appears
              below it when pan is meaningful (cover-fit + overflow). */}
          {maxed && (
            <div
              {...chromeHoverHandlers}
              // Right-side column. Shares the reel/toolbar baseline now that
              // toolbar moved to the left — they're three pieces of one
              // horizontal row instead of a stacked column.
              className={`absolute right-[var(--kn-chrome-pad)] z-20 ${chromeFadeClass}
                          ${item.kind === 'video' ? 'bottom-[var(--kn-controls-clearance)]' : 'bottom-3'}
                          flex flex-col gap-1.5 items-center`}
            >
              {/* Zoom + fit/cover pill — available in the full-screen view,
                  including slideshow. */}
              <div className="flex items-center gap-1 bg-black/80
                              rounded-md ring-1 ring-zinc-800 text-zinc-200 text-xs
                              kn-chrome-scaled">
                  <button
                    onClick={zoomOut}
                    disabled={zoom <= fitFloorZoom + 0.001}
                    title="Zoom out (−)"
                    aria-label="Zoom out"
                    className="px-2 py-1.5 hover:bg-white/10 rounded-l-md transition
                               disabled:opacity-40 disabled:cursor-not-allowed
                               disabled:hover:bg-transparent"
                  >
                    <ZoomOutIcon />
                  </button>
                  <div className="px-1 flex items-center justify-center tabular-nums">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={zoomEditing ? zoomDraft : String(Math.round(zoom * 100))}
                      onFocus={(e) => {
                        setZoomEditing(true);
                        setZoomDraft(String(Math.round(zoom * 100)));
                        e.currentTarget.select();
                      }}
                      onChange={(e) => setZoomDraft(e.target.value.replace(/[^\d]/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        else if (e.key === 'Escape') {
                          zoomCancelRef.current = true;
                          e.currentTarget.blur();
                        }
                      }}
                      onBlur={() => {
                        setZoomEditing(false);
                        if (zoomCancelRef.current) { zoomCancelRef.current = false; return; }
                        applyZoomPercent(zoomDraft);
                      }}
                      aria-label="Zoom percentage"
                      title="Set zoom level — type a percentage"
                      className="w-9 bg-transparent text-right outline-none
                                 focus:text-emerald-300 cursor-text"
                    />
                    <span className="select-none pl-0.5">%</span>
                  </div>
                  <button
                    onClick={zoomIn}
                    disabled={zoom >= MAX_ZOOM - 0.001}
                    title="Zoom in (+)"
                    aria-label="Zoom in"
                    className="px-2 py-1.5 hover:bg-white/10 transition
                               disabled:opacity-40 disabled:cursor-not-allowed
                               disabled:hover:bg-transparent"
                  >
                    <ZoomInIcon />
                  </button>
                  <button
                    onClick={toggleFitFill}
                    disabled={fitFloorZoom >= 0.999}
                    title={zoom <= fitFloorZoom + 0.01 ? 'Fill (crop edges) — C' : 'Fit (whole image) — C'}
                    aria-label={zoom <= fitFloorZoom + 0.01 ? 'Fill' : 'Fit'}
                    className="px-2 py-1.5 hover:bg-white/10 transition
                               rounded-r-md border-l border-zinc-700/60
                               disabled:opacity-40 disabled:cursor-not-allowed
                               disabled:hover:bg-transparent"
                  >
                    {zoom <= fitFloorZoom + 0.01 ? <FitCoverIcon /> : <FitContainIcon />}
                  </button>
                </div>

              {/* Slideshow controls — pause/play + speed slider. Photo-only:
                  on a video, the video player owns playback (its own pause
                  button is the right control), and the slideshow "paused"
                  state only suppresses auto-advance-after-end, which has no
                  visible effect during the video. Esc still exits slideshow. */}
              {slideshow && item.kind === 'photo' && (
                <div className="flex items-center gap-2 bg-black/80
                                rounded-md ring-1 ring-zinc-800 text-zinc-200 text-xs
                                px-2 py-1.5">
                  <button
                    onClick={() => { setPaused((p) => !p); pulseChrome(); }}
                    title={paused ? 'Play slideshow (Space)' : 'Pause slideshow (Space)'}
                    aria-label={paused ? 'Play slideshow' : 'Pause slideshow'}
                    className="px-1.5 py-0.5 rounded hover:bg-white/10 transition
                               flex items-center justify-center"
                  >
                    {paused ? <SlideshowPlayIcon /> : <SlideshowPauseIcon />}
                  </button>
                  <span className="select-none text-zinc-400 pl-1">Speed</span>
                  <input
                    type="range"
                    min={SLIDESHOW_MIN_MS}
                    max={SLIDESHOW_MAX_MS}
                    step={SLIDESHOW_STEP_MS}
                    value={slideshowPhotoMs}
                    onChange={(e) => setSlideshowPhotoMs(Number(e.target.value))}
                    aria-label="Slideshow speed"
                    title="Time per photo · , slower · . faster"
                    className="w-24 accent-emerald-400 cursor-pointer"
                  />
                  <span className="tabular-nums select-none min-w-[2.25rem] text-right pr-1">
                    {(slideshowPhotoMs / 1000).toFixed(0)}s
                  </span>
                </div>
              )}

              {/* Minimap — shown in the full-screen view (incl. slideshow)
                  whenever pan is meaningful (cover-fit + overflow). */}
              <ViewportMinimap
                  src={item.previewUrl}
                  contentRatio={(item.width ?? 1) / (item.height ?? 1)}
                  contentDisplayWidth={panBounds.cw}
                  contentDisplayHeight={panBounds.ch}
                  viewportWidth={panBounds.vw}
                  viewportHeight={panBounds.vh}
                  pan={pan}
                  maxX={isPanEnabled ? panBounds.maxX : 0}
                  maxY={isPanEnabled ? panBounds.maxY : 0}
                  zoom={zoom}
                  onPanChange={handleMinimapPan}
                  onPanCommit={handleMinimapCommit}
                  // Clicking the (inactive) minimap snaps fill↔whole-image,
                  // same as the pill's Fit/Fill button.
                  onActivate={toggleFitFill}
                />
            </div>
          )}

          {/* Coming-up film strip — visible in every viewer mode, including
              slideshow. Position bumps clear of video native controls when
              applicable. */}
          {reelItems && onSelectItem && position && (
            <div
              data-component="viewer-reel-wrapper"
              className={`absolute inset-x-0 z-20 ${chromeFadeClass}
                          ${item.kind === 'video' ? (maxed ? 'bottom-[var(--kn-controls-clearance)]' : 'bottom-24') : 'bottom-3'}
                          px-3 flex justify-center pointer-events-none`}
            >
              <div className="pointer-events-auto" {...chromeHoverHandlers}>
                <ViewerReel
                  items={reelItems}
                  currentIndex={position.index}
                  hasMore={reelHasMore ?? false}
                  onSelect={onSelectItem}
                />
              </div>
            </div>
          )}

        </div>

        {/* Sidebar — normal mode only */}
        {!maxed && (
          <div className="md:w-80 bg-zinc-900/80 backdrop-blur rounded-xl p-5 ml-6
                          flex flex-col gap-3 text-sm overflow-y-auto self-stretch">
            <div className="flex items-start gap-2">
              <h2 className="font-medium text-base text-zinc-100 break-all flex-1">
                {item.filename}
              </h2>
              {onSetLikes && (
                <LikeControl
                  count={displayLikes}
                  onBump={bumpLikes}
                  sparkleKey={sparkleKey}
                  compact
                />
              )}
            </div>

            {effectiveSensitive(item.nsfwScore, item.violenceScore, item.sensitiveOverride) && (
              <SensitiveBadge
                nsfwScore={item.nsfwScore}
                violenceScore={item.violenceScore}
              />
            )}

            {onSeeSimilar && (
              <button
                onClick={() => onSeeSimilar(item)}
                className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-md
                           py-2 text-sm font-medium transition flex items-center justify-center gap-2"
              >
                <SparkleIcon />
                See similar
              </button>
            )}

            {/* Reassign affordance — only shown when we're inside a person
                filter, since "reassign from X" needs a known X. The picker
                handles the rest (move to a different person, split off into
                a new one, or unassign). */}
            {currentPersonUuid && onReassignPerson && (
              <button
                onClick={() => onReassignPerson(item)}
                className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-md
                           py-2 text-sm font-medium transition flex items-center justify-center gap-2"
              >
                <ReassignIcon />
                Reassign person
              </button>
            )}

            {/* Rotate — photo-only. Click cycles 0 → 90 → 180 → 270 → 0.
                Persists server-side; applied via CSS transform on render. */}
            {item.kind === 'photo' && onRotate && (
              <button
                onClick={() => {
                  const next = (((item.rotation ?? 0) + 90) % 360) as 0 | 90 | 180 | 270;
                  onRotate(item, next);
                }}
                title={`Rotate (currently ${item.rotation ?? 0}°)`}
                className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-md
                           py-2 text-sm font-medium transition flex items-center justify-center gap-2"
              >
                <RotateIcon />
                Rotate 90°
              </button>
            )}

            {/* Lower-traffic actions — add to playlist, move, sensitivity, and
                the destructive exclude — live behind a kebab so they don't
                compete with the primary buttons above. */}
            {(onAddToPlaylist || onMove || onSetSensitive || onExclude) && (
              <div className="flex justify-end">
                <ViewerKebabMenu
                  onAddToPlaylist={onAddToPlaylist ? () => onAddToPlaylist(item) : undefined}
                  onMove={onMove ? () => onMove(item) : undefined}
                  sensitive={onSetSensitive ? {
                    effective: effectiveSensitive(item.nsfwScore, item.violenceScore, item.sensitiveOverride),
                    overridden: item.sensitiveOverride != null,
                  } : null}
                  onSetSensitive={onSetSensitive ? (override) => onSetSensitive(item, override) : undefined}
                  onExclude={onExclude ? () => onExclude(item) : undefined}
                />
              </div>
            )}

            <Field label="Type" value={item.kind} />
            {item.width && item.height && (
              <Field label="Dimensions" value={`${item.width} × ${item.height}`} />
            )}
            {item.durationMs && (
              <Field label="Duration" value={formatDuration(item.durationMs)} />
            )}
            {item.capturedAt && (
              <Field label="Captured" value={new Date(item.capturedAt).toLocaleString()} />
            )}
            {item.capturedPlace && <Field label="Place" value={item.capturedPlace} />}
            {(item.cameraMake || item.cameraModel) && (
              <Field
                label="Camera"
                value={[item.cameraMake, item.cameraModel].filter(Boolean).join(' ')}
              />
            )}
            {item.sizeBytes && (
              <Field label="Size" value={formatBytes(item.sizeBytes)} />
            )}

            {item.scores && (
              <div className="mt-3 pt-3 border-t border-zinc-800 space-y-1">
                <div className="text-xs uppercase text-zinc-500 tracking-wider">Search scores</div>
                <Field label="Visual match" value={(item.scores.vector * 100).toFixed(1) + '%'} />
                {item.scores.fts !== null && (
                  <Field label="Text match" value={item.scores.fts.toFixed(2)} />
                )}
                <Field label="Final" value={(item.scores.final * 100).toFixed(1) + '%'} />
              </div>
            )}

            <DetailsSection item={item} />

            <div className="mt-auto pt-3 border-t border-zinc-800 text-xs text-zinc-500 space-y-1">
              <div>
                <kbd className="text-zinc-300">F</kbd> max ·{' '}
                <kbd className="text-zinc-300">←</kbd>{' '}
                <kbd className="text-zinc-300">→</kbd> nav ·{' '}
                <kbd className="text-zinc-300">Esc</kbd> close
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Floating top-right toolbar ───────────────────────────────── */}
      <div
        {...chromeHoverHandlers}
        onClick={(e) => e.stopPropagation()}
        // In maxed mode the toolbar docks at the bottom-left, sharing a
        // baseline with the reel (bottom-center) and the pan/zoom widget
        // (right) — one row of chrome instead of stacked y-positions. Non-
        // maxed (preview modal) keeps the toolbar at top-right since the
        // sidebar takes the right and the bottom is unavailable.
        //
        // Positioning is on this OUTER wrapper, zoom is on the INNER row —
        // CSS `zoom` multiplies position offsets too, so combining `bottom-...`
        // and `kn-chrome-scaled` on the same element makes the toolbar's
        // effective y drift with the chrome-scale steps. Split layers keep
        // its bottom locked at --kn-controls-clearance regardless of scale.
        className={`absolute z-10 ${chromeFadeClass}
                    ${maxed
                      ? `left-[var(--kn-chrome-pad)] ${item.kind === 'video' ? 'bottom-[var(--kn-controls-clearance)]' : 'bottom-3'}`
                      : 'right-4 top-4'}`}
      >
        <div className={`flex gap-2 ${maxed ? 'kn-chrome-scaled' : ''}`}>
        {/* Like control shown only in maxed mode — the preview sidebar
            has its own LikeControl, so duplicating it here would be
            redundant (and the floating one used to close the modal
            because clicks bubbled to the backdrop). */}
        {maxed && onSetLikes && (
          <LikeControl
            count={displayLikes}
            onBump={bumpLikes}
            sparkleKey={sparkleKey}
          />
        )}
        {maxed && (
          <>
            {onAddToPlaylist && (
              <ToolbarButton
                onClick={() => onAddToPlaylist(item)}
                title="Add to playlist…"
              >
                <PlaylistAddIcon />
              </ToolbarButton>
            )}
            {FEATURES.voiceTagging && (
              <button
                type="button"
                disabled={maxedVoiceTagger.status.kind === 'processing'}
                onPointerDown={(e) => { e.preventDefault(); maxedVoiceTagger.start(); }}
                onPointerUp={maxedVoiceTagger.stop}
                onPointerLeave={() => {
                  if (maxedVoiceTagger.status.kind === 'recording') maxedVoiceTagger.stop();
                }}
                onPointerCancel={() => {
                  if (maxedVoiceTagger.status.kind === 'recording') maxedVoiceTagger.stop();
                }}
                title="Hold to record voice tags (V)"
                className={`w-8 h-8 rounded grid place-items-center transition select-none
                            ${maxedVoiceTagger.status.kind === 'recording'
                              ? 'bg-red-950/70 text-red-200 ring-1 ring-red-700/60'
                              : 'bg-zinc-900/80 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'}
                            disabled:opacity-50 disabled:cursor-wait`}
              >
                <MicIcon recording={maxedVoiceTagger.status.kind === 'recording'} />
              </button>
            )}
            {item.kind === 'photo' && onRotate && (
              <ToolbarButton
                onClick={() => {
                  const next = (((item.rotation ?? 0) + 90) % 360) as 0 | 90 | 180 | 270;
                  onRotate(item, next);
                }}
                title={`Rotate (currently ${item.rotation ?? 0}°)`}
              >
                <RotateIcon />
              </ToolbarButton>
            )}
            {onExclude && (
              <ToolbarButton
                onClick={() => onExclude(item)}
                title="Exclude (hide from all results)"
                className="text-red-300 hover:text-red-200 ring-1 ring-red-900/50"
              >
                <TrashIcon />
              </ToolbarButton>
            )}
            <ToolbarButton onClick={() => setMaxed(false)} title="Restore — F or Esc">
              <MinimizeIcon />
            </ToolbarButton>
          </>
        )}
        {/* Close stays inline in the top-right toolbar in preview mode. In
            maxed mode it's pulled out to its own top-right corner below
            (intuitive dismiss spot) while the rest of the toolbar docks
            bottom-left by the progress bar. */}
        {!maxed && (
          <ToolbarButton
            onClick={handleStepBack}
            title="Close (Esc)"
          >
            <CloseIcon />
          </ToolbarButton>
        )}
        </div>
      </div>

      {/* ── Floating top-right close (maxed only) ────────────────────────
          Separated from the bottom-left toolbar so the dismiss affordance
          lives where users instinctively reach for it. Outer wrapper holds
          the position; inner layer holds the chrome-scale zoom (the two
          can't share an element — see the toolbar comment above). */}
      {maxed && (
        <div
          {...chromeHoverHandlers}
          onClick={(e) => e.stopPropagation()}
          className={`absolute top-4 right-4 z-10 ${chromeFadeClass}`}
        >
          <div className="kn-chrome-scaled">
            <ToolbarButton
              onClick={handleStepBack}
              title={slideshow ? 'Exit slideshow (Esc)' : 'Back to preview (Esc)'}
            >
              <CloseIcon />
            </ToolbarButton>
          </div>
        </div>
      )}

      {/* ── Nav arrows ──────────────────────────────────────────────── */}
      <div {...chromeHoverHandlers} className={chromeFadeClass}>
        <NavButton side="left"  onClick={onPrev} disabled={!onPrev} scaled={maxed} {...chromeHoverHandlers} />
        <NavButton side="right" onClick={onNext} disabled={!onNext} scaled={maxed} {...chromeHoverHandlers} />
      </div>


      {position && (
        // Positioning outside, zoom inside — see toolbar comment above for the
        // reason `top-4` and `kn-chrome-scaled` can't share an element.
        <div {...chromeHoverHandlers} className={`absolute top-4 left-4 z-10 ${chromeFadeClass}`}>
          <div className={`flex items-center gap-2 ${maxed ? 'kn-chrome-scaled' : ''}`}>
            <div className={`${maxed ? 'bg-black/80' : 'bg-black/40'}
                            text-zinc-200 text-sm rounded-md px-3 py-1.5`}>
              {position.index + 1} / {position.total}
            </div>
            {effectiveSensitive(item.nsfwScore, item.violenceScore, item.sensitiveOverride) && (
              <SensitiveBadge
                nsfwScore={item.nsfwScore}
                violenceScore={item.violenceScore}
                floating
              />
            )}
          </div>
        </div>
      )}

      {/* Maxed-mode voice-tag HUD. Shows recording / processing / done
          state in a top-centred pill since the sidebar isn't visible
          here. Mirrors the sidebar's inline status line via the same
          status object so messaging stays consistent. Stays visible
          while recording (overrides chrome fade) so the user always
          knows the mic is hot. */}
      {FEATURES.voiceTagging && maxed && maxedVoiceTagger.status.kind !== 'idle' && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 pointer-events-none
                        flex flex-col items-center gap-1">
          {maxedVoiceTagger.status.kind === 'recording' && (
            <div className="bg-red-950/90 text-red-200 text-xs
                            rounded-full px-3 py-1.5 ring-1 ring-red-700/60
                            flex items-center gap-2 animate-pulse">
              <MicIcon recording />
              <span>Listening… release V to tag</span>
            </div>
          )}
          {maxedVoiceTagger.status.kind === 'processing' && (
            <div className="bg-zinc-900/90 text-zinc-300 text-xs
                            rounded-full px-3 py-1.5 ring-1 ring-zinc-700">
              Transcribing…
            </div>
          )}
          {(maxedVoiceTagger.status.kind === 'done' || maxedVoiceTagger.status.kind === 'error') && (
            <div className="bg-black/90 text-xs rounded-md px-3 py-1.5
                            ring-1 ring-zinc-800 max-w-md text-center">
              <VoiceTagStatusLine status={maxedVoiceTagger.status} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Like control (used in both sidebar and floating toolbar) ──────────────

function LikeControl({
  count,
  onBump,
  sparkleKey = 0,
  compact = false,
}: {
  count: number;
  onBump: () => void;
  /** Incremented by the parent on every like so the sparkle restarts. */
  sparkleKey?: number;
  compact?: boolean;
}) {
  const tooltip =
    count === 0 ? 'Like (click to add)'
    : count >= MAX_LIKES ? `${MAX_LIKES} likes — click to reset`
    : `${count} like${count === 1 ? '' : 's'} — click for more`;

  // Wrap the heart in a `relative` span so the absolute sparkle particles
  // anchor to the heart's center, not the whole button (which is wider
  // when a count is showing). Mounted only after the first bump so the
  // initial render doesn't fire a burst.
  const sparkles = sparkleKey > 0 ? <SparkleBurst key={sparkleKey} /> : null;

  if (compact) {
    return (
      <button
        onClick={onBump}
        title={tooltip}
        aria-label={tooltip}
        className="flex items-center gap-1 px-2 py-1 rounded
                   bg-zinc-800 hover:bg-zinc-700 transition shrink-0"
      >
        <span className="relative inline-flex items-center justify-center">
          <Heart count={count} size={14} />
          {sparkles}
        </span>
        {count > 0 && (
          <span className="text-xs font-semibold tabular-nums" style={{ color: likeFillColor(count) ?? undefined }}>{count}</span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={onBump}
      title={tooltip}
      aria-label={tooltip}
      className="bg-black/80 hover:bg-black/95 text-zinc-100
                 rounded-md h-9 px-2.5 flex items-center gap-1.5 transition"
    >
      <span className="relative inline-flex items-center justify-center">
        <Heart count={count} size={16} />
        {sparkles}
      </span>
      {count > 0 && (
        <span className="text-sm font-semibold tabular-nums" style={{ color: likeFillColor(count) ?? undefined }}>{count}</span>
      )}
    </button>
  );
}

function Heart({ count, size = 14 }: { count: number; size?: number }) {
  const color = likeFillColor(count);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={color ?? 'none'}
      stroke={color ?? 'currentColor'}
      strokeWidth="1.6"
      strokeLinejoin="round"
    >
      <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
    </svg>
  );
}


function SensitiveBadge({
  nsfwScore,
  violenceScore,
  floating = false,
}: {
  nsfwScore: number;
  violenceScore: number;
  floating?: boolean;
}) {
  const tooltip =
    `Flagged — nsfw ${(nsfwScore * 100).toFixed(0)}%, ` +
    `violence ${(violenceScore * 100).toFixed(0)}%`;
  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 text-amber-300
                  text-[11px] font-medium px-2 py-0.5 rounded-full
                  border border-amber-700/50
                  ${floating ? 'bg-amber-950/90' : 'bg-amber-950/60'}`}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1.5l7 12.5H1L8 1.5z" />
        <path d="M8 6v4M8 12v0.5" />
      </svg>
      Sensitive
    </span>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

function NavButton({
  side,
  onClick,
  disabled,
  scaled = false,
  onMouseEnter,
  onMouseLeave,
  'data-kn-chrome': dataChrome,
}: {
  side: 'left' | 'right';
  onClick?: () => void;
  disabled?: boolean;
  /** Grow on large displays (maxed mode). The zoom lives on the inner button,
   *  not this positioned wrapper, so the top-1/2 centering stays exact. */
  scaled?: boolean;
  /** Forwarded to the positioned wrapper so hovering an arrow holds the chrome
   *  idle timer open. They can't be spread on the chrome group wrapper because
   *  it's zero-size (children are absolutely positioned to the viewer root). */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Chrome marker so the root mouse-move handler counts an arrow as chrome. */
  'data-kn-chrome'?: string;
}) {
  if (disabled) return null;
  return (
    <div
      data-kn-chrome={dataChrome}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`absolute top-1/2 -translate-y-1/2 z-10
                  ${side === 'left' ? 'left-4' : 'right-4'}`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClick?.(); }}
        // Rapid double-clicks on the nav arrows raise a native `dblclick`
        // event; swallow it here so it can't reach the media element below
        // (which has its own click-to-toggle-play behavior on videos).
        onDoubleClick={(e) => e.stopPropagation()}
        title={side === 'left' ? 'Previous — ⇧← or J' : 'Next — ⇧→ or K'}
        aria-label={side === 'left' ? 'Previous' : 'Next'}
        className={`w-11 h-11 rounded-full bg-black/80 hover:bg-black/95
                    text-zinc-100 flex items-center justify-center transition shadow-lg
                    ${scaled ? 'kn-chrome-scaled' : ''}`}
      >
        {side === 'left' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
      </button>
    </div>
  );
}

function ToolbarButton({
  onClick,
  title,
  children,
  className = '',
  disabled = false,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`bg-black/80 hover:bg-black/95 text-zinc-100
                  rounded-md w-9 h-9 flex items-center justify-center transition
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-black/60
                  ${className}`}
    >
      {children}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200 text-right break-words">{value}</span>
    </div>
  );
}

function DetailsSection({ item }: { item: MediaItemDto }) {
  const [expanded, setExpanded] = useState(true);
  const [ocrExpanded, setOcrExpanded] = useState(false);
  const [tagInput, setTagInput] = useState('');

  const utils = trpc.useUtils();
  const details = trpc.media.getDetails.useQuery(
    { uuid: item.uuid, librarySlug: item.librarySlug },
    { enabled: !!item },
  );

  const addTag = trpc.media.addUserTag.useMutation({
    onSuccess: () => {
      utils.media.getDetails.invalidate();
      utils.media.facets.invalidate();
      setTagInput('');
    },
  });

  const removeTag = trpc.media.removeUserTag.useMutation({
    onSuccess: () => {
      utils.media.getDetails.invalidate();
      utils.media.facets.invalidate();
    },
  });

  const submitTag = async (e: React.FormEvent) => {
    e.preventDefault();
    // Accept either a single tag or a comma-separated list. Splitting in
    // the client (vs. teaching addUserTag to accept arrays) keeps the
    // server mutation single-purpose; the existing onConflict upsert
    // makes duplicate submissions cheap and idempotent.
    const names = Array.from(new Set(
      tagInput.split(',').map((s) => s.trim()).filter(Boolean),
    ));
    if (names.length === 0) return;
    // Sequential to avoid SQLITE_BUSY on the shared media_tags index for
    // the same row. Counts are small (typically 1-5).
    for (const name of names) {
      try {
        await addTag.mutateAsync({
          uuid: item.uuid,
          librarySlug: item.librarySlug,
          name,
        });
      } catch {
        // Skip per-tag failures; loop continues so the user doesn't lose
        // the rest of a batch because of one duplicate or length error.
      }
    }
    setTagInput('');
  };

  if (!details.data && !details.isLoading) return null;
  const d = details.data;
  const OCR_TRUNCATE = 180;
  const ocrIsLong = (d?.ocrText?.length ?? 0) > OCR_TRUNCATE;

  return (
    <div className="mt-3 pt-3 border-t border-zinc-800">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between mb-2
                   text-xs uppercase text-zinc-500 tracking-wider hover:text-zinc-300 transition"
      >
        <span>AI metadata</span>
        <span className="text-zinc-600">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="space-y-2 text-xs">
          {details.isLoading && <div className="text-zinc-500">Loading…</div>}

          {d && (
            <>
              {d.enrichmentStatus !== 'done' && (
                <div className={`px-2 py-1 rounded ${
                  d.enrichmentStatus === 'failed'
                    ? 'bg-red-950/40 text-red-300'
                    : 'bg-amber-950/40 text-amber-300'
                }`}>
                  Enrichment: {d.enrichmentStatus}
                </div>
              )}

              {d.aiCaption && (
                <DetailBlock label="Caption" body={d.aiCaption} />
              )}

              {d.ocrText && (
                <div>
                  <div className="text-zinc-500 mb-0.5">OCR text</div>
                  <div className="text-zinc-200 leading-relaxed break-words font-mono text-[11px]
                                  bg-zinc-950/40 rounded px-2 py-1.5">
                    {ocrIsLong && !ocrExpanded
                      ? d.ocrText.slice(0, OCR_TRUNCATE) + '…'
                      : d.ocrText}
                  </div>
                  {ocrIsLong && (
                    <button
                      onClick={() => setOcrExpanded((v) => !v)}
                      className="text-zinc-500 hover:text-zinc-300 mt-1"
                    >
                      {ocrExpanded ? 'show less' : `show more (${d.ocrText.length} chars)`}
                    </button>
                  )}
                </div>
              )}

              {d.transcript && (
                <DetailBlock label="Transcript" body={d.transcript} />
              )}

              <div>
                <div className="text-zinc-500 mb-1">Tags ({d.tags.length})</div>
                <div className="flex flex-wrap gap-1">
                  {d.tags.map((t) => {
                    const isUser = t.source === 'user';
                    return (
                      <span
                        key={`${t.source}-${t.name}`}
                        className={`px-1.5 py-0.5 rounded text-[10px] border
                                    inline-flex items-center gap-1
                                    ${isUser
                                      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/50'
                                      : 'bg-zinc-800 text-zinc-300 border-zinc-700/50'}`}
                      >
                        {t.name}
                        {isUser && (
                          <button
                            onClick={() => removeTag.mutate({
                              uuid: item.uuid,
                              librarySlug: item.librarySlug,
                              name: t.name,
                            })}
                            disabled={removeTag.isPending}
                            className="text-emerald-500 hover:text-emerald-200 leading-none ml-0.5"
                            title="Remove tag"
                            aria-label="Remove tag"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>

                <form onSubmit={submitTag} className="mt-1.5 flex items-center gap-1.5">
                  <input
                    type="text"
                    placeholder="Add tags (comma-separated)…"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    disabled={addTag.isPending}
                    maxLength={60}
                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1
                               text-[11px] focus:border-zinc-600 outline-none disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={addTag.isPending || !tagInput.trim()}
                    className="text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-30
                               px-2 py-1"
                  >
                    Add
                  </button>
                </form>
                {addTag.error && (
                  <div className="text-[10px] text-red-400 mt-1">
                    {addTag.error.message}
                  </div>
                )}

                {FEATURES.voiceTagging && (
                  <VoiceTagButton
                    uuid={item.uuid}
                    librarySlug={item.librarySlug}
                    onCommitted={(tags) => {
                      if (tags.length > 0) {
                        utils.media.getDetails.invalidate();
                        utils.media.facets.invalidate();
                      }
                    }}
                  />
                )}
              </div>

              <div className="pt-2 mt-2 border-t border-zinc-800/60 space-y-0.5
                              text-[10px] font-mono text-zinc-600">
                <DebugId label="uuid" value={d.uuid} />
                <DebugId label="lib"  value={d.librarySlug} />
                {d.sha256 && (
                  <DebugId label="sha" value={d.sha256.slice(0, 12) + '…'} />
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DetailBlock({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="text-zinc-500 mb-0.5">{label}</div>
      <div className="text-zinc-200 leading-relaxed break-words">{body}</div>
    </div>
  );
}

function DebugId({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{label}</span>
      <button
        onClick={() => {
          if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(value);
        }}
        className="text-zinc-500 hover:text-zinc-300 transition"
        title="Click to copy"
      >
        {value}
      </button>
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────

function MaximizeIcon() { return (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" strokeLinecap="round" />
  </svg>
); }
function MinimizeIcon() { return (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" strokeLinecap="round" />
  </svg>
); }
function FitCoverIcon() { return (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="3" width="10" height="10" rx="1" />
    <path d="M5 8h6M8 5v6" strokeLinecap="round" />
  </svg>
); }
function FitContainIcon() { return (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="4" width="12" height="8" rx="1" />
  </svg>
); }
function ZoomInIcon() { return (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="7" cy="7" r="4" />
    <path d="M5 7h4M7 5v4M10 10l3 3" strokeLinecap="round" />
  </svg>
); }
function ZoomOutIcon() { return (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="7" cy="7" r="4" />
    <path d="M5 7h4M10 10l3 3" strokeLinecap="round" />
  </svg>
); }
function CloseIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
  </svg>
); }
function ChevronLeftIcon() { return (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
); }
function ChevronRightIcon() { return (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
); }
function SparkleIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 1l1.5 4L13 6.5l-3.5 1.5L8 12l-1.5-4L3 6.5l3.5-1.5L8 1z" />
  </svg>
); }
function SlideshowPlayIcon() { return (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 2.5v11l9-5.5z" />
  </svg>
); }
function SlideshowPauseIcon() { return (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <rect x="3.5" y="2.5" width="3" height="11" rx="0.5" />
    <rect x="9.5" y="2.5" width="3" height="11" rx="0.5" />
  </svg>
); }
function PlaylistAddIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4h10M2 8h7M2 12h4" />
    <path d="M12 9v6M9 12h6" />
  </svg>
); }
function ReassignIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="5" r="2.2" />
    <path d="M2 13c0-1.8 1.3-3 3-3" />
    <circle cx="11" cy="11" r="2.2" />
    <path d="M9.5 4.5l3-3M12.5 1.5l1 1M12.5 1.5h-2" />
  </svg>
); }
function RotateIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {/* Three-quarter-circle arrow suggesting "rotate 90°". */}
    <path d="M3 8a5 5 0 0 1 9-3" />
    <path d="M12 2v3h-3" />
  </svg>
); }
function TrashIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4" />
  </svg>
); }

// Kebab ("⋮") menu for secondary viewer actions. Currently just "Move to
// library…", kept out of the prominent button stack so it's low-traffic.
function ViewerKebabMenu({
  onAddToPlaylist,
  onMove,
  sensitive,
  onSetSensitive,
  onExclude,
}: {
  onAddToPlaylist?: () => void;
  onMove?: () => void;
  sensitive?: { effective: boolean; overridden: boolean } | null;
  onSetSensitive?: (override: 0 | 1 | null) => void;
  onExclude?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const itemClass = 'w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 flex items-center gap-2.5';
  const run = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="More actions"
        aria-label="More actions"
        className="w-8 h-8 rounded-md grid place-items-center text-zinc-400 hover:text-zinc-100
                   hover:bg-zinc-800 transition"
      >
        <KebabIcon />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-zinc-900 border border-zinc-800
                        rounded-lg shadow-xl py-1 z-20">
          {onAddToPlaylist && (
            <button type="button" onClick={run(onAddToPlaylist)} className={itemClass}>
              <PlaylistAddIcon /> Add to playlist…
            </button>
          )}
          {onMove && (
            <button type="button" onClick={run(onMove)} className={itemClass}>
              <MoveIcon /> Move to library…
            </button>
          )}

          {sensitive && onSetSensitive && (
            <>
              <div className="border-t border-zinc-800 my-1" />
              {sensitive.effective ? (
                <button type="button" onClick={run(() => onSetSensitive(0))} className={itemClass}>
                  <ShieldIcon /> Mark as safe
                </button>
              ) : (
                <button type="button" onClick={run(() => onSetSensitive(1))} className={itemClass}>
                  <FlagIcon /> Mark as sensitive
                </button>
              )}
              {sensitive.overridden && (
                <button type="button" onClick={run(() => onSetSensitive(null))} className={itemClass}>
                  <ResetIcon /> Reset to auto-detection
                </button>
              )}
            </>
          )}

          {onExclude && (
            <>
              <div className="border-t border-zinc-800 my-1" />
              <button
                type="button"
                onClick={run(onExclude)}
                className="w-full text-left px-3 py-2 text-sm text-red-300 hover:bg-red-950/40
                           hover:text-red-200 flex items-center gap-2.5"
              >
                <TrashIcon /> Exclude…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FlagIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 14V2.5M3.5 3h7l-1.2 2.4L10.5 8h-7" />
  </svg>
); }

function ShieldIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 1.8l5 1.8v3.5c0 3.1-2.1 5.2-5 6.1-2.9-.9-5-3-5-6.1V3.6l5-1.8Z" />
    <path d="M5.8 8l1.6 1.6L10.4 6.5" />
  </svg>
); }

function ResetIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8a5 5 0 1 1 1.5 3.5M3 8V5M3 8h3" />
  </svg>
); }

function KebabIcon() { return (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="3" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="8" cy="13" r="1.4" />
  </svg>
); }

function MoveIcon() { return (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6" />
    <path d="M9 9.5h5M12 7.5l2 2-2 2" />
    <path d="M2 4.5v7A1.5 1.5 0 0 0 3.5 13H7" />
  </svg>
); }

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
