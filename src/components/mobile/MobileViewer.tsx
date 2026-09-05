'use client';

import { useEffect, useRef, useState } from 'react';
import type { MediaItemDto } from '@/components/MediaGrid';
import {
  clearVideoProgress,
  getVideoProgress,
  setVideoProgress,
} from '@/lib/video-progress';

const CHROME_IDLE_MS = 2500;
const SWIPE_THRESHOLD_PX = 50;
const SWIPE_MAX_DURATION_MS = 500;
const SWIPE_DOM_RATIO = 2; // |dx| must be at least 2× |dy| to count as horizontal
const MAX_LIKES = 5;
const VIDEO_PROGRESS_SAVE_THROTTLE_MS = 2000;
const VIDEO_PROGRESS_RESUME_MIN = 2;
const VIDEO_PROGRESS_RESUME_TAIL = 5;

interface Props {
  item: MediaItemDto | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onSetLikes?: (item: MediaItemDto, count: number) => Promise<void> | void;
  /** Persist a rotation override for the current photo. */
  onRotate?: (item: MediaItemDto, rotation: 0 | 90 | 180 | 270) => void;
  /** Pause playback while the screensaver is up so audio doesn't leak behind it. */
  suspended?: boolean;
  /** Whether the images-only slideshow is currently running. */
  slideshow?: boolean;
  /** Show the play/pause control at all (needs ≥2 photos to be worthwhile). */
  canSlideshow?: boolean;
  /** Toggle the slideshow on/off. */
  onToggleSlideshow?: () => void;
  /** Current per-photo dwell (ms) — shown on the speed control. */
  slideshowMs?: number;
  /** Lengthen the dwell (slower). */
  onSlower?: () => void;
  /** Shorten the dwell (faster). */
  onFaster?: () => void;
  /** At the dwell bounds → disable the corresponding direction. */
  atMinSpeed?: boolean;
  atMaxSpeed?: boolean;
  /** How media fills the screen: 'cover' fills (cropping), 'contain' letterboxes. */
  fit?: 'cover' | 'contain';
  /** Flip the fit — persisted as the default via the shared preference. */
  onToggleFit?: () => void;
  /** Photo-aware prev/next for the slideshow transport (wrap; skip videos). */
  onSlideshowPrev?: () => void;
  onSlideshowNext?: () => void;
}

/**
 * Touch-first viewer. Distinct from MediaViewer:
 *   - no sidebar, no hover affordances, no keyboard shortcuts
 *   - tap toggles chrome; swipe left/right navigates between items
 *   - chrome auto-hides after CHROME_IDLE_MS
 *
 * VideoPlayer is reused as-is — its own controls work fine on touch.
 */
export function MobileViewer({
  item, onClose, onPrev, onNext, onSetLikes, onRotate, suspended = false,
  slideshow = false, canSlideshow = false, onToggleSlideshow,
  slideshowMs = 0, onSlower, onFaster, atMinSpeed = false, atMaxSpeed = false,
  fit = 'cover', onToggleFit, onSlideshowPrev, onSlideshowNext,
}: Props) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);

  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // Set by a manual slideshow step (prev/next) so the item-change effect keeps
  // the controls visible instead of hiding them the way it does on auto-advance.
  const manualNavRef = useRef(false);

  // Optimistic like overlay — same model as the desktop viewer's pendingLikes
  // but with a simpler single-tap path (no shortcut, no debounce; if you tap
  // four times rapidly we just send four requests — mobile users don't
  // typically drum on the heart).
  const [pendingLikes, setPendingLikes] = useState<number | null>(null);
  const displayLikes = pendingLikes ?? item?.likeCount ?? 0;

  useEffect(() => {
    setPendingLikes(null);
  }, [item?.uuid]);

  // Catch-up: clear optimistic once the server count matches.
  useEffect(() => {
    if (pendingLikes !== null && item && pendingLikes === item.likeCount) {
      setPendingLikes(null);
    }
  }, [item?.likeCount, item, pendingLikes]);

  const pulseChrome = () => {
    setChromeVisible(true);
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(
      () => setChromeVisible(false),
      CHROME_IDLE_MS,
    );
  };

  useEffect(() => {
    if (!item) return;
    // During a running slideshow, keep the chrome out of the way so it doesn't
    // flash on every AUTO-advance. But a MANUAL step (prev/next) should leave the
    // controls up — its onClick already pulsed them — so honor that flag.
    if (slideshow) {
      if (manualNavRef.current) { manualNavRef.current = false; return; }
      setChromeVisible(false);
      return;
    }
    pulseChrome();
    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.uuid, slideshow]);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { x: t.clientX, y: t.clientY, t: performance.now() };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dt = performance.now() - start.t;

    // For videos, the native controls own taps (play/pause/seek). Only
    // swipe-to-navigate is honored from this layer; tap-toggle-chrome is
    // photo-only.
    const isVideo = item?.kind === 'video';

    if (!isVideo && Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 350) {
      if (chromeVisible) setChromeVisible(false);
      else pulseChrome();
      return;
    }

    if (
      dt < SWIPE_MAX_DURATION_MS &&
      Math.abs(dx) > SWIPE_THRESHOLD_PX &&
      Math.abs(dx) > SWIPE_DOM_RATIO * Math.abs(dy)
    ) {
      if (dx < 0) onNext?.();
      else onPrev?.();
      pulseChrome();
    }
  };

  if (!item) return null;

  const tapLike = () => {
    if (!onSetLikes) return;
    const base = pendingLikes ?? item.likeCount;
    const next = base >= MAX_LIKES ? 0 : base + 1;
    setPendingLikes(next);
    void onSetLikes(item, next);
    pulseChrome();
  };

  // For videos the native player owns most of the UX, so the close/like
  // chrome stays visible at all times (the native controls auto-hide on
  // their own). For photos the chrome fades after CHROME_IDLE_MS unless
  // touched again.
  const isVideo = item.kind === 'video';
  const chromeClass = isVideo
    ? ''
    : `transition-opacity duration-200 ${chromeVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`;

  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {item.kind === 'photo' ? (
        <img
          src={item.previewUrl}
          alt={item.filename}
          draggable={false}
          className={`absolute inset-0 w-full h-full select-none transition-transform duration-200
                      ${fit === 'cover' ? 'object-cover' : 'object-contain'}`}
          style={item.rotation ? { transform: `rotate(${item.rotation}deg)` } : undefined}
        />
      ) : (
        <NativeVideo
          src={item.mediaUrl}
          progressKey={`${item.librarySlug}:${item.uuid}`}
          onFullscreenExit={onClose}
          suspended={suspended}
          fit={fit}
        />
      )}

      {/* Top chrome — close + like. Swallow touches so tapping a control
          doesn't also trigger the background's tap-to-toggle (which would hide
          the chrome out from under the press). */}
      <div
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
        className={`absolute top-0 inset-x-0 z-10 ${chromeClass}
                    px-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3
                    bg-gradient-to-b from-black/70 to-transparent
                    flex items-center justify-between`}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="w-14 h-14 rounded-full bg-black/40 backdrop-blur
                     text-zinc-100 flex items-center justify-center"
        >
          <CloseIcon />
        </button>

        <div className="flex items-center gap-3">
          {canSlideshow && onToggleSlideshow && (
            <button
              onClick={onToggleSlideshow}
              aria-label={slideshow ? 'Pause slideshow' : 'Play slideshow'}
              className="w-14 h-14 rounded-full bg-black/40 backdrop-blur
                         text-zinc-100 flex items-center justify-center"
            >
              {slideshow ? <PauseIcon /> : <PlayIcon />}
            </button>
          )}
          {item.kind === 'photo' && onRotate && (
            <button
              onClick={() => {
                const next = (((item.rotation ?? 0) + 90) % 360) as 0 | 90 | 180 | 270;
                onRotate(item, next);
              }}
              aria-label="Rotate"
              className="w-14 h-14 rounded-full bg-black/40 backdrop-blur
                         text-zinc-100 flex items-center justify-center"
            >
              <RotateIcon />
            </button>
          )}
          {onSetLikes && (
            <button
              onClick={tapLike}
              aria-label="Like"
              className="h-14 px-5 rounded-full bg-black/40 backdrop-blur
                         text-zinc-100 flex items-center gap-2"
            >
              <Heart filled={displayLikes > 0} />
              {displayLikes > 0 && (
                <span className="text-sm font-semibold text-rose-400 tabular-nums">
                  {displayLikes}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Bottom chrome. During a slideshow this hosts the speed control; the
          rest of the time it's the photo's filename. On videos the native
          controls live here, so we paint neither. */}
      {slideshow && onSlower && onFaster ? (
        <div
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          className={`absolute bottom-0 inset-x-0 z-10 ${chromeClass}
                      pb-[max(env(safe-area-inset-bottom),1rem)] pt-8
                      flex justify-center`}
        >
          <div className="flex items-center gap-1 rounded-full bg-black/50 backdrop-blur px-1.5 py-1.5">
            {onSlideshowPrev && (
              <SpeedButton
                label="Previous photo"
                onClick={() => { manualNavRef.current = true; onSlideshowPrev(); pulseChrome(); }}
              >
                <PrevIcon />
              </SpeedButton>
            )}
            <SpeedButton label="Faster" disabled={atMinSpeed} onClick={() => { onFaster(); pulseChrome(); }}>
              <MinusIcon />
            </SpeedButton>
            <span className="w-12 text-center text-sm font-medium tabular-nums text-zinc-100">
              {formatInterval(slideshowMs)}
            </span>
            <SpeedButton label="Slower" disabled={atMaxSpeed} onClick={() => { onSlower(); pulseChrome(); }}>
              <PlusIcon />
            </SpeedButton>
            {onSlideshowNext && (
              <SpeedButton
                label="Next photo"
                onClick={() => { manualNavRef.current = true; onSlideshowNext(); pulseChrome(); }}
              >
                <NextIcon />
              </SpeedButton>
            )}
            {onToggleFit && (
              <SpeedButton
                label={fit === 'cover' ? 'Fit to screen' : 'Fill screen'}
                onClick={() => { onToggleFit(); pulseChrome(); }}
              >
                {fit === 'cover' ? <ContractIcon /> : <ExpandIcon />}
              </SpeedButton>
            )}
          </div>
        </div>
      ) : (!isVideo && (
        <div
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          className={`absolute bottom-0 inset-x-0 z-10 ${chromeClass}
                      px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-6
                      bg-gradient-to-t from-black/70 to-transparent
                      flex items-center gap-2`}
        >
          <span className="flex-1 min-w-0 truncate text-zinc-300 text-xs">{item.filename}</span>
          {onToggleFit && (
            <button
              onClick={onToggleFit}
              aria-label={fit === 'cover' ? 'Fit whole photo to screen' : 'Fill the screen'}
              title={fit === 'cover' ? 'Fit to screen' : 'Fill screen'}
              className="shrink-0 w-11 h-11 -mr-1 flex items-center justify-center rounded-full
                         text-zinc-100 active:bg-white/10"
            >
              {fit === 'cover' ? <ContractIcon /> : <ExpandIcon />}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Native HTML5 video with iOS/Android browser controls. We layer the
 * existing per-item progress memory on top so resuming a video on mobile
 * picks up where it left off (same key shape as desktop —
 * `<slug>:<uuid>` — so progress is shared cross-device).
 */
function NativeVideo({
  src,
  progressKey,
  onFullscreenExit,
  suspended = false,
  fit = 'cover',
}: {
  src: string;
  progressKey: string;
  onFullscreenExit: () => void;
  suspended?: boolean;
  fit?: 'cover' | 'contain';
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const lastSaveRef = useRef(0);

  // Pause when the screensaver comes up so the clip's audio doesn't play behind
  // the black overlay. We don't auto-resume on exit — the user taps play.
  useEffect(() => {
    if (suspended) ref.current?.pause();
  }, [suspended]);

  const persist = (force = false) => {
    const v = ref.current;
    if (!v || !v.duration || Number.isNaN(v.duration)) return;
    const now = Date.now();
    if (!force && now - lastSaveRef.current < VIDEO_PROGRESS_SAVE_THROTTLE_MS) return;
    setVideoProgress(progressKey, v.currentTime);
    lastSaveRef.current = now;
  };

  // Flush on unmount / src change so navigating to the next item doesn't
  // lose the position you were just at.
  useEffect(() => {
    return () => persist(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressKey]);

  // Auto-enter fullscreen as soon as metadata is ready. The tap on the
  // thumbnail counts as the activation gesture — the mount + metadata
  // chain is fast enough that browsers still consider the gesture live.
  // On iOS Safari `webkitEnterFullscreen` hands you the actual native
  // iOS video player (the polished one with AirPlay, scrub, etc.).
  // Failures (denied, unsupported) silently fall back to the inline
  // controls, so nothing breaks if the API isn't available.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let cancelled = false;

    type IOSVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    const enter = () => {
      if (cancelled) return;
      const iosV = v as IOSVideo;
      if (typeof iosV.webkitEnterFullscreen === 'function') {
        try { iosV.webkitEnterFullscreen(); } catch { /* ignore */ }
        return;
      }
      if (typeof v.requestFullscreen === 'function') {
        v.requestFullscreen().catch(() => { /* denied / unsupported */ });
      }
    };

    if (v.readyState >= 1) enter();
    else v.addEventListener('loadedmetadata', enter, { once: true });

    // Exit fullscreen → close the modal entirely, returning the user
    // straight to the grid. iOS fires `webkitendfullscreen` on the video
    // element; the standard API fires `fullscreenchange` on document and
    // we treat any transition to no-fullscreen-element as our exit (only
    // one element can be in fullscreen at a time per spec).
    const onIosExit = () => onFullscreenExit();
    const onStandardChange = () => {
      if (!document.fullscreenElement) onFullscreenExit();
    };
    v.addEventListener('webkitendfullscreen', onIosExit);
    document.addEventListener('fullscreenchange', onStandardChange);

    return () => {
      cancelled = true;
      v.removeEventListener('loadedmetadata', enter);
      v.removeEventListener('webkitendfullscreen', onIosExit);
      document.removeEventListener('fullscreenchange', onStandardChange);
    };
  }, [src, onFullscreenExit]);

  return (
    <video
      ref={ref}
      src={src}
      controls
      autoPlay
      playsInline
      // Restore prior position when metadata is ready, skipping silly
      // edge cases (within 2s of start or 5s of end).
      onLoadedMetadata={(e) => {
        const dur = e.currentTarget.duration;
        const saved = getVideoProgress(progressKey);
        if (
          saved !== null &&
          saved > VIDEO_PROGRESS_RESUME_MIN &&
          dur > VIDEO_PROGRESS_RESUME_TAIL &&
          saved < dur - VIDEO_PROGRESS_RESUME_TAIL
        ) {
          e.currentTarget.currentTime = saved;
        }
      }}
      onTimeUpdate={() => persist(false)}
      onPause={() => persist(true)}
      onEnded={() => {
        // Played all the way through — clear so next open starts fresh.
        clearVideoProgress(progressKey);
        lastSaveRef.current = 0;
      }}
      className={`absolute inset-0 w-full h-full bg-black
                  ${fit === 'cover' ? 'object-cover' : 'object-contain'}`}
    />
  );
}

function CloseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
    </svg>
  );
}

/** Per-photo dwell as a short label, e.g. 5500 → "5.5s", 6000 → "6s". */
function formatInterval(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

function SpeedButton({
  label, disabled = false, onClick, children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="w-11 h-11 rounded-full flex items-center justify-center text-zinc-100
                 active:bg-white/10 disabled:opacity-30 transition"
    >
      {children}
    </button>
  );
}

function MinusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="4" y="3.5" width="1.8" height="9" rx="0.6" />
      <path d="M12.5 4v8l-6-4z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3.5 4v8l6-4z" />
      <rect x="10.2" y="3.5" width="1.8" height="9" rx="0.6" />
    </svg>
  );
}

/** Corner brackets pointing outward — "fill the screen". */
function ExpandIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
    </svg>
  );
}

/** Corner brackets pointing inward — "fit the whole photo". */
function ContractIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 4 2.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="3.5" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="9" y="2.5" width="3.5" height="11" rx="1" />
    </svg>
  );
}

function RotateIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8a5 5 0 0 1 9-3" />
      <path d="M12 2v3h-3" />
    </svg>
  );
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 16 16"
      fill={filled ? '#f43f5e' : 'none'}
      stroke={filled ? '#f43f5e' : 'currentColor'}
      strokeWidth="1.6"
      strokeLinejoin="round"
    >
      <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
    </svg>
  );
}
