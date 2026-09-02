'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShortcut } from '@/lib/shortcuts';
import { useHideCornerPredicate } from '@/lib/hot-corner-client';
import { resumePlayback } from '@/lib/resume-playback';
import { restoreAudioOwner, writeAudioOwner } from '@/lib/audio-owner';
import { usePreference } from '@/lib/preferences';
import { useSync, useSyncEvent } from '@/lib/sync';
import { flashHud } from '@/lib/action-hud';
import { BookmarkWheel } from '@/components/BookmarkWheel';
import {
  clearVideoProgress,
  getVideoProgress,
  setVideoProgress,
} from '@/lib/video-progress';

const PROGRESS_SAVE_THROTTLE_MS = 2000;
// Don't restore positions in the first/last few seconds — likely the user
// just started or finished and resuming there feels weird.
const PROGRESS_RESUME_MIN = 2;          // seconds into video
const PROGRESS_RESUME_TAIL = 5;          // seconds from end

interface Props {
  src: string;
  autoPlay?: boolean;
  className?: string;
  videoClassName?: string;
  /** Inline style applied to the `<video>` element only — used for pan
   *  (object-position) so that overlay controls stay anchored to the
   *  viewport while the displayed video pixels shift. */
  videoStyle?: React.CSSProperties;
  /** Tap ←/→ when no hold: navigate to previous/next item. */
  onPrev?: () => void;
  onNext?: () => void;
  /** Fires once when the video reaches its natural end. Used by the
   *  slideshow to auto-advance past a video to the next playlist item. */
  onEnded?: () => void;
  /** Stable identifier for per-video state (progress memory). If omitted,
   *  progress persistence is disabled. Use `"<librarySlug>:<itemUuid>"`. */
  progressKey?: string;
  /** Initial seek position in ms. Used by search-result deep-links so the
   *  viewer opens at the match timestamp. Takes precedence over saved
   *  progress when both are present. */
  initialTimeMs?: number | null;
  /** Scale the bottom controls bar on large displays — same `kn-chrome-scaled`
   *  zoom that the MediaViewer chrome uses. Caller sets true in maxed mode so
   *  the preview-modal video keeps its compact controls. */
  scaled?: boolean;
  /** External pause gate (e.g. the screensaver overlay). While true the video
   *  is held paused; when it clears we resume ONLY if the video was playing
   *  when the gate engaged — a user-initiated pause is preserved. */
  forcePaused?: boolean;
  /** Loop the video natively. With this on the element never reaches its
   *  natural end, so `onEnded` doesn't fire — the slideshow uses it to pin
   *  the current video on repeat instead of advancing. */
  loop?: boolean;
  /** When provided, the controls bar shows a loop toggle button next to the
   *  timer. `loop` drives its active (highlighted) state; clicking fires this.
   *  Omitted outside the slideshow, so the button only appears there. */
  onToggleLoop?: () => void;
  /** Bookmarks to show as ticks on the scrubber (click a tick to seek). */
  bookmarks?: Array<{ id: number; timestampMs: number; label: string }>;
  /** When provided, the controls bar shows an "add bookmark" button; it fires
   *  with the current playback position in ms. */
  onAddBookmark?: (timeMs: number) => void;
  /** This user's "climax" mark (ms) for the video, shown as a distinct amber
   *  marker on the scrubber (click to seek). Null when unset. */
  climaxMs?: number | null;
  /** When provided, the controls bar shows a "set climax" (★) button; it fires
   *  with the current playback position in ms. */
  onSetClimax?: (timeMs: number) => void;
  /** When provided, the "couldn't play" error panel offers to exclude the video
   *  from results after repeated failed retries (a likely-corrupt file). Fires
   *  with no args — the parent knows which item is open. */
  onExclude?: () => void;
  /** Your most-used bookmark labels + a commit handler → enables the quick
   *  scroll-wheel bookmark picker over the bottom controls (see BookmarkWheel). */
  topBookmarkLabels?: string[];
  onQuickBookmark?: (timeMs: number, label: string) => void;
  /** Called once on mount with an imperative handle, so an outside panel (the
   *  bookmark list / trim editor) or a climax-jump can seek, read the position,
   *  or resume play without a ref. */
  onApi?: (api: { seek: (ms: number) => void; currentMs: () => number; play: () => void; showControls: () => void }) => void;
  /** Autoplay trim window (ms). Applied ONLY when `enforceTrim` is true (the
   *  slideshow): playback starts at `trimStartMs` and stops/advances at
   *  `trimEndMs`. Both nullable. Shown as a shaded region on the scrubber
   *  regardless, so the trim is visible while editing. */
  trimStartMs?: number | null;
  trimEndMs?: number | null;
  enforceTrim?: boolean;
  /** When provided, a drag-to-trim handle track is shown below the scrubber.
   *  Fires on release with the new bounds (null = that end is untrimmed). */
  onTrimChange?: (startMs: number | null, endMs: number | null) => void;
  /** Scrub-preview sprite: montage URL + grid manifest. When present, hovering
   *  the scrubber shows the video frame at that moment. */
  scrubSprite?: {
    url: string; intervalMs: number; cols: number; rows: number;
    tileW: number; tileH: number; count: number;
  } | null;
}

/**
 * Custom video player. Native controls are disabled so our shortcuts don't
 * conflict with the browser's built-in handlers. Progress bar updates 60fps
 * via rAF + direct ref mutation — no React re-renders per frame.
 *
 * Shortcuts registered while mounted:
 *   Space / K       play / pause
 *   J               -10s
 *   L               +10s
 *   M               mute
 *   0-9             jump to %
 *   ← tap           previous item (via onPrev prop)
 *   ← hold          rewind (scrub backward)
 *   → tap           next item (via onNext prop)
 *   → hold          fast-forward (scrub forward)
 */
export function VideoPlayer({
  src,
  autoPlay = true,
  className = '',
  videoClassName = 'w-full h-full',
  scaled = false,
  videoStyle,
  onPrev,
  onNext,
  onEnded,
  progressKey,
  initialTimeMs,
  forcePaused = false,
  bookmarks,
  onAddBookmark,
  climaxMs,
  onSetClimax,
  onExclude,
  topBookmarkLabels,
  onQuickBookmark,
  onApi,
  trimStartMs,
  trimEndMs,
  enforceTrim = false,
  onTrimChange,
  scrubSprite,
  loop = false,
  onToggleLoop,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const bufferedRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef<HTMLSpanElement>(null);
  const inHideCorner = useHideCornerPredicate();

  const [playing, setPlaying] = useState(false);
  // True while the video has no playable data yet — initial load (slow when a
  // snoozing drive is spinning up) or mid-playback buffering. Drives a spinner
  // so a black screen doesn't read as "nothing's happening".
  const [buffering, setBuffering] = useState(true);
  // The <video> fired an error event — the source failed to load/decode, i.e.
  // it's likely damaged or an unsupported codec. Reset on item swap.
  const [damaged, setDamaged] = useState(false);
  // How many times the user has retried THIS source without it playing. After a
  // few failed retries the error panel offers to exclude the (likely corrupt)
  // video. Reset on item swap and on a successful play (onPlaying).
  const [retryCount, setRetryCount] = useState(0);
  const RETRIES_BEFORE_EXCLUDE = 3;
  // A new src is loading until it can play — reset immediately on item swap.
  useEffect(() => { setBuffering(true); setDamaged(false); setRetryCount(0); }, [src]);
  // Retry after an error — re-fetch the same source. The `error` event fires on
  // transient issues too (a drive spinning up, a momentary stall), so a reload
  // often succeeds; if it genuinely can't decode, onError just flips back (and
  // the retry counter climbs toward the exclude prompt).
  const retry = () => {
    setRetryCount((c) => c + 1);
    setDamaged(false);
    setBuffering(true);
    const el = videoRef.current;
    if (el) { try { el.load(); void el.play().catch(() => {}); } catch { /* ignore */ } }
  };
  // Only actually show the spinner if buffering lasts >200ms, so fast/cached
  // loads don't flash it.
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    if (!buffering) { setShowSpinner(false); return; }
    const t = window.setTimeout(() => setShowSpinner(true), 200);
    return () => window.clearTimeout(t);
  }, [buffering]);

  // Buffering watchdog — self-heal a spinner that would otherwise spin forever.
  // `buffering` is cleared ONLY by the canplay/playing events; when the initial
  // load silently stalls (e.g. the audio-owner probe racing native autoplay into
  // a paused, low-readyState dead-end, or decoder/drive contention) neither event
  // fires, no `error` fires either, and nothing else recovers — so the spinner is
  // stuck until the user reopens the item. This polls while buffering: if the
  // element is actually ready we missed the event → clear it (and nudge play);
  // if it's making NO forward progress for a couple of ticks → load()+play() to
  // restart the pipeline, the automatic equivalent of reopening. Skipped while a
  // pause gate (screensaver) is engaged so it can't fight that.
  useEffect(() => {
    if (!buffering || damaged) return;
    if (!videoRef.current) return;
    let stalledTicks = 0;
    let lastBufferedEnd = -1;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || forcePaused) return;
      if (v.readyState >= 3 /* HAVE_FUTURE_DATA */) {
        setBuffering(false);
        if (autoPlay && v.paused && !v.ended) v.play().catch(() => {});
        return;
      }
      // Source went missing (e.g. stripped by a StrictMode remount) → a bare
      // load() can't recover, so re-assert it before restarting.
      if (src && !v.getAttribute('src')) {
        v.setAttribute('src', src);
        v.load();
        if (autoPlay) void v.play().catch(() => {});
        stalledTicks = 0;
        lastBufferedEnd = -1;
        return;
      }
      const bufferedEnd = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      if (bufferedEnd > lastBufferedEnd + 0.01) {
        // Still pulling data in — slow drive/network, but progressing. Leave it.
        lastBufferedEnd = bufferedEnd;
        stalledTicks = 0;
        return;
      }
      // No forward progress this tick. After ~6s truly stuck, restart the load
      // (resets currentTime → re-fires loadedmetadata, which re-applies the
      // resume/trim/deep-link seek), then retry until it catches or errors.
      if (++stalledTicks >= 2) {
        stalledTicks = 0;
        lastBufferedEnd = -1;
        try { v.load(); if (autoPlay) void v.play().catch(() => {}); } catch { /* ignore */ }
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [buffering, damaged, autoPlay, forcePaused, src]);

  // Release the media decoder on unmount. A detached <video> keeps its src +
  // buffered data and — because it autoPlays — KEEPS DECODING off-screen until
  // GC (non-deterministic). Opening/closing several videos piled up live 1080p
  // decoders, saturating the main thread until shortcuts AND clicks stopped
  // responding. Explicitly pausing + dropping the src + load() frees the decode
  // pipeline immediately. (The element is captured at mount; videoRef is stable
  // across item swaps, so this only fires on a real close, not prev/next.)
  //
  // StrictMode caveat: in dev, React runs every effect mount → cleanup → mount.
  // That intermediate cleanup strips `src` off the LIVE element, and React won't
  // re-apply an unchanged `src` prop — so the video was stranded at networkState
  // EMPTY and spun forever ("sometimes", depending on whether the item's src was
  // present at first commit or arrived a render later). Re-assert the committed
  // src on (re)mount to repair that strip. No-op in prod, where cleanup only runs
  // on a true unmount, so the attribute is never missing when setup runs.
  useEffect(() => {
    const video = videoRef.current;
    if (video && src && !video.getAttribute('src')) {
      video.setAttribute('src', src);
      video.load();
    }
    return () => {
      if (!video) return;
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* best-effort */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Volume *level* stays a cross-tab preference (same loudness everywhere).
  // Mute starts on for every fresh element (autoplay-policy friendly), but the
  // per-window "audio owner" state IS remembered across a reload: if this window
  // was the unmuted owner, it comes back unmuted (see the restore effect below +
  // src/lib/audio-owner.ts). Other windows keep their own sessionStorage, so
  // muted windows stay muted and only one window ever owns audio (solo rule).
  const [muted, setMuted] = useState(true);
  // Latest `muted` in a ref so the sync handler can check it WITHOUT a
  // side-effecting state updater (flashing the HUD inside setMuted's updater
  // runs during render → "can't update ActionHud while rendering VideoPlayer").
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const [volume, setVolume] = usePreference('videoVolume');
  const [duration, setDuration] = useState<number | null>(null);
  // Scrubber hover → the sprite-sheet frame preview (portaled). Viewport coords.
  const [scrubHover, setScrubHover] = useState<{ x: number; y: number; timeMs: number } | null>(null);
  useEffect(() => { setScrubHover(null); }, [src]);

  // Solo-audio coordination over the sync layer (same-browser via
  // BroadcastChannel + cross-device via SSE): unmuting THIS window broadcasts
  // `audio.unmuted` so every other window/device mutes; receiving it mutes us.
  // Muting broadcasts nothing — everyone just stays muted until a manual unmute.
  const sync = useSync();
  useSyncEvent('audio.unmuted', () => {
    // Flash the HUD only when we actually LOSE audio (were unmuted) — so a
    // background mute is visible, without flashing every already-muted window.
    // Side effect lives OUTSIDE the state updater (updaters must stay pure).
    if (!mutedRef.current) flashHud('mute');
    setMuted(true);
    writeAudioOwner(false); // soloed out by someone else → no longer the owner
  });
  const applyMute = (next: boolean) => {
    setMuted(next);
    flashHud(next ? 'mute' : 'unmute');
    writeAudioOwner(!next); // remember ownership across reloads (this window only)
    if (!next) sync.publish({ type: 'audio.unmuted' });
  };

  // Restore this window's audio ownership across a reload: if we were the
  // unmuted owner, probe autoplay permission and come back unmuted if the
  // browser grants sound (otherwise stay muted — no hacks; see audio-owner.ts).
  // Runs once per mount; the returned cleanup cancels the probe, so React
  // StrictMode's dev double-invoke nets out to a single live arming. No manual
  // guard — a ref guard would let StrictMode's cleanup cancel run #1 while run
  // #2 no-ops.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return restoreAudioOwner(video, {
      onUnmuted: () => applyMute(false), // sound granted → unmute + solo + flash
      onMuted: () => setMuted(true),     // refused → element already muted; keep intent
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [controlsVisible, setControlsVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);

  // Small stack of pre-seek positions so users can undo an accidental jump.
  // Pushed BEFORE each deliberate seek (skip, jump-to-%, scrub, drag, etc.),
  // never on natural playback progression. Capped at 5 — older entries
  // fall off the bottom.
  const seekHistoryRef = useRef<number[]>([]);
  const SEEK_HISTORY_MAX = 5;
  const SEEK_HISTORY_MIN_DELTA = 0.5; // seconds; ignores micro-corrections

  // ── 60fps progress paint via rAF (no React re-renders). ───────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let rafId = 0;
    const tick = () => {
      const dur = video.duration;
      if (dur > 0 && !Number.isNaN(dur)) {
        const frac = video.currentTime / dur;
        if (playedRef.current) playedRef.current.style.transform = `scaleX(${frac})`;
        if (thumbRef.current) thumbRef.current.style.left = `${frac * 100}%`;
        if (currentTimeRef.current) currentTimeRef.current.textContent = formatTime(video.currentTime);
        if (video.buffered.length > 0 && bufferedRef.current) {
          const bufferedEnd = video.buffered.end(video.buffered.length - 1);
          bufferedRef.current.style.transform = `scaleX(${bufferedEnd / dur})`;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ── Action handlers ───────────────────────────────────────────────────────

  function recordSeekPoint() {
    const video = videoRef.current;
    if (!video) return;
    const current = video.currentTime;
    const stack = seekHistoryRef.current;
    const last = stack[stack.length - 1];
    // Don't record if effectively unchanged from the last point — keeps the
    // 5-slot buffer free for meaningful steps.
    if (last !== undefined && Math.abs(last - current) < SEEK_HISTORY_MIN_DELTA) return;
    stack.push(current);
    if (stack.length > SEEK_HISTORY_MAX) stack.shift();
  }

  function undoSeek() {
    const video = videoRef.current;
    if (!video) return;
    const previous = seekHistoryRef.current.pop();
    if (previous === undefined) return;
    video.currentTime = previous;
  }

  // Wipe history when the source changes — old timestamps are meaningless
  // on a different video.
  useEffect(() => {
    seekHistoryRef.current = [];
  }, [src]);

  // ── Per-video playback position memory ──────────────────────────────
  //
  // When the user navigates away and comes back to a video, resume where
  // they left off (within sanity bounds). Persistence is per progressKey,
  // not per src — same video opened in different libraries would have
  // different keys, but the same item across sessions is consistent.
  const lastSaveRef = useRef(0);

  const persistProgress = (force = false) => {
    if (!progressKey) return;
    const video = videoRef.current;
    if (!video || !video.duration || Number.isNaN(video.duration)) return;
    const now = Date.now();
    if (!force && now - lastSaveRef.current < PROGRESS_SAVE_THROTTLE_MS) return;
    setVideoProgress(progressKey, video.currentTime);
    lastSaveRef.current = now;
  };

  // Flush on unmount and when progressKey changes (e.g., navigating to a
  // different video — record the OLD video's position before we lose it).
  useEffect(() => {
    return () => persistProgress(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressKey]);

  // Hand an imperative handle to the parent (bookmark jumps, trim editor) once
  // on mount. videoRef is stable across item swaps, so the closures stay valid.
  useEffect(() => {
    onApi?.({
      seek: (ms: number) => {
        const v = videoRef.current;
        if (v) v.currentTime = Math.max(0, ms / 1000);
      },
      currentMs: () => Math.round((videoRef.current?.currentTime ?? 0) * 1000),
      play: () => { videoRef.current?.play().catch(() => {}); },
      showControls: () => showControls(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effective trim window in seconds — only when the slideshow enforces it.
  const trimStartS = enforceTrim && trimStartMs != null ? trimStartMs / 1000 : null;
  const trimEndS = enforceTrim && trimEndMs != null ? trimEndMs / 1000 : null;
  // Fire the trim-end advance only once per playthrough (reset on (re)load).
  const trimFiredRef = useRef(false);

  // ── Drag-to-trim handles (below the scrubber) ────────────────────────────
  const trimTrackRef = useRef<HTMLDivElement>(null);
  const [trimDrag, setTrimDrag] = useState<{ which: 'start' | 'end'; startMs: number; endMs: number } | null>(null);
  const durMs = duration ? Math.round(duration * 1000) : 0;
  // Effective handle positions: the live drag if any, else the props (a null
  // bound shows at the very edge — 0 for start, full duration for end).
  const effStartMs = trimDrag ? trimDrag.startMs : (trimStartMs ?? 0);
  const effEndMs = trimDrag ? trimDrag.endMs : (trimEndMs ?? durMs);
  const pct = (ms: number) => (durMs ? Math.max(0, Math.min(100, (ms / durMs) * 100)) : 0);

  const trimDown = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setTrimDrag({ which, startMs: trimStartMs ?? 0, endMs: trimEndMs ?? durMs });
  };
  const trimMove = (e: React.PointerEvent) => {
    if (!trimDrag || !trimTrackRef.current || !durMs) return;
    const rect = trimTrackRef.current.getBoundingClientRect();
    const ms = Math.round(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * durMs);
    const GAP = 250; // keep at least 0.25s between in and out
    setTrimDrag((d) => d && (d.which === 'start'
      ? { ...d, startMs: Math.min(ms, d.endMs - GAP) }
      : { ...d, endMs: Math.max(ms, d.startMs + GAP) }));
  };
  const trimUp = (e: React.PointerEvent) => {
    if (!trimDrag) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    // A bound dragged to the very edge clears it (untrimmed on that side).
    const startMs = trimDrag.startMs <= 0 ? null : trimDrag.startMs;
    const endMs = durMs > 0 && trimDrag.endMs >= durMs ? null : trimDrag.endMs;
    onTrimChange?.(startMs, endMs);
    setTrimDrag(null);
  };

  // Also flush before the tab unloads / hides.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHide = () => persistProgress(true);
    window.addEventListener('beforeunload', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressKey]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    // Catch the play() promise: a quick pause (or the screensaver engaging)
    // before it resolves rejects with an AbortError — benign, so swallow it.
    if (video.paused) { video.play().catch(() => {}); flashHud('play'); }
    else { video.pause(); flashHud('pause'); }
  }

  // External pause gate (screensaver). Pause while engaged; on release resume
  // only if the video was actually playing when it engaged, so a user pause
  // survives a screensaver show/dismiss. Keyed on `forcePaused` alone — we
  // sample play state at the transition, not on every render.
  const resumeOnReleaseRef = useRef(false);
  const resumeCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (forcePaused) {
      resumeOnReleaseRef.current = !video.paused;
      video.pause();
    } else if (resumeOnReleaseRef.current) {
      resumeOnReleaseRef.current = false;
      // Resilient resume: the drive may have spun down or the stream re-buffered
      // while the screensaver was up, so play() can reject. Retry until ready.
      resumeCancelRef.current = resumePlayback(video);
    }
    // Cancel an in-flight resume if we re-suspend (or unmount) — so its retries
    // can't fight the pause and race play()/pause() into an AbortError.
    return () => { resumeCancelRef.current?.(); resumeCancelRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcePaused]);

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    const next = !muted;
    if (!next && volume === 0) {
      // Unmuting at zero volume would be silent — nudge to an audible level.
      setVolume(0.5);
      video.volume = 0.5;
    }
    applyMute(next);
  }

  function changeVolume(v: number) {
    setVolume(v);
    // Slider doubles as mute: drag to 0 mutes; drag up from 0 unmutes (and
    // solos audio to this window) — keeps "slider value = audible level".
    if (v === 0 && !muted) applyMute(true);
    else if (v > 0 && muted) applyMute(false);
  }

  // Keep the element's mute/volume in sync with state — covers a remote unmute
  // muting us, slider changes, and per-item element swaps.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    v.volume = volume;
  }, [muted, volume]);

  function seekBy(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    recordSeekPoint();
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
  }

  function jumpToPercent(p: number) {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    recordSeekPoint();
    video.currentTime = video.duration * p;
  }

  // Every video shortcut also pulses the bottom controls so the user sees
  // the effect of their action when the bar would otherwise be idle-hidden.
  useShortcut('video.playPause',     (e) => { e.preventDefault(); togglePlay();        showControls(); });
  useShortcut('video.seekBack10',    (e) => { e.preventDefault(); seekBy(-10);         showControls(); });
  useShortcut('video.seekForward10', (e) => { e.preventDefault(); seekBy(10);          showControls(); });
  useShortcut('video.mute',          (e) => { e.preventDefault(); toggleMute();        showControls(); });
  useShortcut('video.jumpToPercent', (e) => {
    if (!/^[0-9]$/.test(e.key)) return;
    jumpToPercent(parseInt(e.key, 10) / 10);
    showControls();
  });
  useShortcut('video.undoSeek', (e) => { e.preventDefault(); undoSeek(); showControls(); });
  // Retry the failed source. Only armed while the error panel is up. Skip when a
  // modal is open (e.g. the exclude confirm) so Enter confirms THAT, not both.
  useShortcut('video.retry', (e) => {
    if (typeof document !== 'undefined' &&
        document.querySelector('[role="alertdialog"], [role="dialog"]')) return;
    e.preventDefault();
    retry();
  }, { enabled: damaged });

  // ── Drag-to-seek on the progress bar. ─────────────────────────────────────
  const dragRef = useRef<{ active: boolean; rect: DOMRect | null }>({ active: false, rect: null });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.active || !dragRef.current.rect) return;
      const video = videoRef.current;
      if (!video || !video.duration) return;
      const rect = dragRef.current.rect;
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      video.currentTime = ratio * video.duration;
    };
    const onUp = () => { dragRef.current = { active: false, rect: null }; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  function startSeekDrag(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = { active: true, rect };
    const video = videoRef.current;
    if (video && video.duration) {
      recordSeekPoint(); // captures pre-drag position
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      video.currentTime = ratio * video.duration;
    }
  }

  function showControls() {
    setControlsVisible(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    // Arm the auto-hide whenever the video is actually playing. Read the
    // element (not the `playing` state) so this also works when called from
    // onPlay in the same tick as setPlaying(true) — e.g. a slideshow
    // auto-advancing to a new video with no mouse activity to re-arm it. Hide
    // regardless of cursor position (Netflix/YouTube-style) so the bar can't
    // stay pinned when it mounts under a stationary cursor on a (re)load.
    if (!videoRef.current?.paused) {
      idleTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2500);
    }
  }

  return (
    <div
      ref={rootRef}
      className={`relative group ${className}`}
      // Ignore movement in a "hide controls" hot corner so a parked mouse jiggler
      // can't keep the controls bar pinned open (matches the viewer chrome).
      onMouseMove={(e) => { if (!inHideCorner(e.clientX, e.clientY)) showControls(); }}
      onMouseLeave={() => playing && setControlsVisible(false)}
    >
      <video
        ref={videoRef}
        src={src}
        autoPlay={autoPlay}
        // Native loop only when there's no enforced trim-end; with a trim-end
        // we loop manually within [start, end] via onTimeUpdate instead.
        loop={loop && trimEndS == null}
        playsInline
        // Mute starts on for every new element (fresh load / item swap / maxed
        // remount); the user unmutes deliberately.
        muted={muted}
        onClick={togglePlay}
        onPlay={() => {
          setPlaying(true);
          showControls();
        }}
        onPause={() => { setPlaying(false); setControlsVisible(true); }}
        // Buffering / loading lifecycle → drives the spinner.
        onWaiting={() => setBuffering(true)}
        onStalled={() => setBuffering(true)}
        onCanPlay={() => setBuffering(false)}
        onPlaying={() => { setBuffering(false); setRetryCount(0); }}
        // Belt-and-suspenders: if enough data landed but canplay/playing were
        // missed (the silent-stall case), clear the spinner as soon as we have
        // future data rather than waiting on the watchdog poll.
        onLoadedData={(e) => { if (e.currentTarget.readyState >= 3) setBuffering(false); }}
        onError={() => { setBuffering(false); setDamaged(true); }}
        onLoadedMetadata={(e) => {
          const dur = e.currentTarget.duration;
          setDuration(dur);
          trimFiredRef.current = false;
          // Initial seek wins over saved progress AND trim — search-result
          // deep-links (?t=ms) explicitly point at a moment the user wants to
          // see; the resume-progress UX would otherwise yank them elsewhere.
          if (initialTimeMs != null && Number.isFinite(initialTimeMs)) {
            const target = Math.max(0, Math.min(dur - 0.1, initialTimeMs / 1000));
            e.currentTarget.currentTime = target;
            return;
          }
          // Autoplay trim: start at the trim-in point (skips the intro). Takes
          // precedence over resume-progress during a slideshow.
          if (trimStartS != null) {
            e.currentTarget.currentTime = Math.max(0, Math.min(dur - 0.1, trimStartS));
            return;
          }
          // Resume position, if any, and if it falls within sane bounds.
          if (progressKey) {
            const saved = getVideoProgress(progressKey);
            if (saved !== null
                && saved > PROGRESS_RESUME_MIN
                && dur > PROGRESS_RESUME_TAIL
                && saved < dur - PROGRESS_RESUME_TAIL) {
              e.currentTarget.currentTime = saved;
            }
          }
        }}
        onTimeUpdate={(e) => {
          persistProgress(false);
          // Autoplay trim-out: at the trim-end, loop back to the start if the
          // slideshow is looping this clip, otherwise advance to the next item.
          if (trimEndS != null && e.currentTarget.currentTime >= trimEndS) {
            const v = e.currentTarget;
            if (loop) {
              v.currentTime = trimStartS ?? 0;
            } else if (!trimFiredRef.current) {
              trimFiredRef.current = true;
              v.pause();
              onEnded?.();
            }
          }
        }}
        onEnded={() => {
          // Finished naturally — clear so the next time the user opens it
          // they start from the beginning rather than 2s before the end.
          if (progressKey) clearVideoProgress(progressKey);
          lastSaveRef.current = 0;
          onEnded?.();
        }}
        className={videoClassName}
        style={videoStyle}
      />

      {/* Loading / buffering spinner — centered over the (possibly still black)
          video so it's clear something's happening while data streams in. */}
      {showSpinner && !damaged && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="w-12 h-12 rounded-full border-2 border-white/25 border-t-white/90 animate-spin" />
        </div>
      )}

      {/* Playback failed — could be a damaged file / unsupported codec, but the
          `error` event also fires on transient hiccups (a snoozing drive, a brief
          network stall), so offer a Retry that re-fetches the same source. */}
      {damaged && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none px-6">
          <div className="flex flex-col items-center gap-2 text-center text-zinc-300">
            <span className="grid place-items-center w-11 h-11 rounded-full bg-rose-950/80 text-rose-300 border border-rose-700/50">
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 1.5l7 12.5H1L8 1.5z" /><path d="M8 6v4M8 12v0.5" />
              </svg>
            </span>
            {retryCount >= RETRIES_BEFORE_EXCLUDE ? (
              <>
                <div className="text-sm font-medium text-zinc-200">This video keeps failing</div>
                <div className="text-xs text-zinc-400 max-w-xs">
                  It didn&apos;t play after {retryCount} tries — the file may be corrupted.
                  Keep trying, or exclude it from results (the file stays on disk; it&apos;s recoverable).
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-medium text-zinc-200">This video couldn&apos;t be played</div>
                <div className="text-xs text-zinc-400 max-w-xs">It may be damaged or in an unsupported format — or the drive was just waking up.</div>
              </>
            )}
            <div className="pointer-events-auto mt-1 flex items-center gap-2">
              <button
                onClick={retry}
                className="inline-flex items-center gap-1.5 rounded-md
                           bg-zinc-100 text-zinc-900 text-sm font-medium px-3 py-1.5 hover:bg-white transition"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2v3h-3" />
                </svg>
                Retry
                <span className="text-[10px] font-normal text-zinc-500 ml-0.5">Enter</span>
              </button>
              {retryCount >= RETRIES_BEFORE_EXCLUDE && onExclude && (
                <button
                  onClick={onExclude}
                  className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium px-3 py-1.5 transition
                             bg-rose-950/80 text-rose-200 ring-1 ring-rose-800/70 hover:bg-rose-900/80"
                >
                  Exclude from search
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent
                    px-4 pb-3 pt-12 transition-opacity duration-200 will-change-[opacity]
                    ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}
                    ${scaled ? 'kn-video-controls-scaled' : ''}`}
      >
        <div
          ref={trimTrackRef}
          onMouseDown={startSeekDrag}
          onMouseMove={(e) => {
            if (!scrubSprite || !durMs) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setScrubHover({ x: e.clientX, y: rect.top, timeMs: ratio * durMs });
          }}
          onMouseLeave={() => setScrubHover(null)}
          // ::before extends the clickable area 15px above/below the visible
          // bar — events on the pseudo bubble to this host, so the existing
          // handler catches them, and getBoundingClientRect() still reports
          // the visible bar's width so seek math is unchanged. Trim grips
          // measure against this same rect, so they map to seek positions 1:1.
          //
          // Only the thin inner bar grows on hover (scaleY — GPU, no layout).
          // The thumb, trim markers, and bookmark strips/tooltips live OUTSIDE
          // it so they DON'T inherit the vertical stretch (which otherwise
          // squashed the round thumb into an ellipse and stretched tooltips).
          className="group/scrub relative h-1.5 cursor-pointer mb-6
                     before:content-[''] before:absolute before:-inset-y-[20px] before:inset-x-0"
        >
          {/* Climax marker — a decorative dark-green starburst that sits BEHIND
              the bar (first child → painted first) as a faint "shadow." Fully
              non-interactive (pointer-events-none, no tooltip/seek), so it never
              conflicts with the bookmark ticks' hover/click. A quiet easter-egg
              cue at the climax; peeks around the thin bar since it's taller. */}
          {duration != null && climaxMs != null && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-0 -translate-y-1/2 -translate-x-1/2 w-[11.25rem] h-[11.25rem] opacity-[0.64]"
              style={{ left: `${Math.max(0, Math.min(100, (climaxMs / 1000 / duration) * 100))}%` }}
            >
              {/* Radiating rays — a dense sunburst (repeating-conic-gradient),
                  hollowed at the centre and faded out with a radial mask. */}
              <div
                className="absolute inset-0"
                style={{
                  background: 'repeating-conic-gradient(from 0deg, rgba(110,231,183,0.5) 0deg 0.5deg, transparent 0.5deg 15deg)',
                  WebkitMaskImage: 'radial-gradient(circle, transparent 9%, #000 18%, transparent 62%)',
                  maskImage: 'radial-gradient(circle, transparent 9%, #000 18%, transparent 62%)',
                  filter: 'blur(0.4px)',
                }}
              />
              {/* Horizontal anamorphic streak. */}
              <div
                className="absolute left-1/2 top-1/2 h-px w-[240%] -translate-x-1/2 -translate-y-1/2"
                style={{
                  background: 'linear-gradient(90deg, transparent, rgba(110,231,183,0.45) 40%, rgba(224,255,244,0.85) 50%, rgba(110,231,183,0.45) 60%, transparent)',
                  filter: 'blur(0.5px)',
                }}
              />
              {/* Hot core — soft white fading to emerald. */}
              <div
                className="absolute inset-0"
                style={{ background: 'radial-gradient(circle, rgba(236,255,247,0.95) 0%, rgba(52,211,153,0.65) 15%, rgba(16,185,129,0.3) 34%, transparent 56%)' }}
              />
            </div>
          )}
          <div className="absolute inset-0 rounded-full bg-zinc-700/60 origin-center
                          transition-transform group-hover/scrub:scale-y-150">
            <div
              ref={bufferedRef}
              className="absolute inset-y-0 left-0 w-full bg-zinc-400/40 rounded-full origin-left"
              style={{ transform: 'scaleX(0)' }}
            />
            <div
              ref={playedRef}
              className="absolute inset-y-0 left-0 w-full bg-emerald-400 rounded-full origin-left"
              style={{ transform: 'scaleX(0)' }}
            />
          </div>

          <div
            ref={thumbRef}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full
                       bg-emerald-400 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ left: '0%' }}
          />


          {/* Bookmark strips — white marker per tagged moment. Hover shows the
              time + tags via the app-wide TooltipLayer (the same styled tooltip
              the climax marker uses) — driven by `title`, so it's consistent and
              can't get trapped under the reel/chrome. Click jumps there; the
              ::before widens the hover/click target beyond the thin strip.
              stopPropagation so the click seeks rather than scrub-drags. */}
          {duration != null && bookmarks?.map((b) => (
            <div
              key={b.id}
              onMouseDown={(e) => {
                e.stopPropagation();
                const v = videoRef.current;
                if (v) { recordSeekPoint(); v.currentTime = b.timestampMs / 1000; }
              }}
              title={`${formatTime(b.timestampMs / 1000)} — ${b.label || '(no tags)'}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[3px] h-3.5 rounded-sm
                         bg-white/90 hover:bg-white cursor-pointer shadow ring-1 ring-black/30
                         before:content-[''] before:absolute before:-inset-x-[5px] before:-inset-y-1.5"
              style={{ left: `${Math.max(0, Math.min(100, (b.timestampMs / 1000 / duration) * 100))}%` }}
            />
          ))}

          {/* Drag-to-trim, ON the bar. Trimmed-out spans are dimmed; the green
              (in) / red (out) grips straddle the bar. Grips stopPropagation so
              grabbing one doesn't seek; drop a grip at the far edge to clear it.
              pointer-events-none on the dim overlays so seeking still works. */}
          {onTrimChange && duration != null && (
            <>
              {effStartMs > 0 && (
                <div
                  className="absolute inset-y-0 left-0 bg-black/55 rounded-l-full pointer-events-none"
                  style={{ width: `${pct(effStartMs)}%` }}
                />
              )}
              {effEndMs < durMs && (
                <div
                  className="absolute inset-y-0 right-0 bg-black/55 rounded-r-full pointer-events-none"
                  style={{ left: `${pct(effEndMs)}%` }}
                />
              )}
              {trimDrag && (
                <div
                  className="absolute -top-5 -translate-x-1/2 text-[10px] tabular-nums text-zinc-100
                             bg-zinc-900/95 rounded px-1 pointer-events-none z-10"
                  style={{ left: `${pct(trimDrag.which === 'start' ? effStartMs : effEndMs)}%` }}
                >
                  {formatTime((trimDrag.which === 'start' ? effStartMs : effEndMs) / 1000)}
                </div>
              )}
              <div
                role="slider" aria-label="Trim start"
                title={`Trim start — ${formatTime(effStartMs / 1000)}`}
                onPointerDown={trimDown('start')} onPointerMove={trimMove} onPointerUp={trimUp}
                onMouseDown={(e) => e.stopPropagation()}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[7px] h-4 rounded-[3px]
                           bg-emerald-400 ring-1 ring-zinc-950 shadow cursor-ew-resize touch-none hover:bg-emerald-300"
                style={{ left: `${pct(effStartMs)}%` }}
              />
              <div
                role="slider" aria-label="Trim stop"
                title={`Trim stop — ${formatTime(effEndMs / 1000)}`}
                onPointerDown={trimDown('end')} onPointerMove={trimMove} onPointerUp={trimUp}
                onMouseDown={(e) => e.stopPropagation()}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[7px] h-4 rounded-[3px]
                           bg-red-400 ring-1 ring-zinc-950 shadow cursor-ew-resize touch-none hover:bg-red-300"
                style={{ left: `${pct(effEndMs)}%` }}
              />
              {(trimStartMs != null || trimEndMs != null) && (
                <button
                  onClick={() => onTrimChange(null, null)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  title="Clear trim"
                  className="absolute right-0 -top-6 text-[10px] text-zinc-400 hover:text-zinc-100"
                >
                  clear trim
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-3 text-zinc-100">
          <ControlButton onClick={togglePlay} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </ControlButton>

          <ControlButton onClick={() => seekBy(-10)} title="Back 10s (J)">
            <SkipBackIcon />
          </ControlButton>
          <ControlButton onClick={() => seekBy(10)} title="Forward 10s (L)">
            <SkipForwardIcon />
          </ControlButton>

          <span className="text-xs text-zinc-300 tabular-nums select-none">
            <span ref={currentTimeRef}>0:00</span>
            <span className="text-zinc-500"> / </span>
            <span>{duration ? formatTime(duration) : '0:00'}</span>
          </span>

          {onAddBookmark && (
            <ControlButton
              onClick={() => onAddBookmark(Math.round((videoRef.current?.currentTime ?? 0) * 1000))}
              title="Add a bookmark at the current moment (B)"
            >
              <BookmarkIcon />
            </ControlButton>
          )}

          {onSetClimax && (
            <ControlButton
              onClick={() => onSetClimax(Math.round((videoRef.current?.currentTime ?? 0) * 1000))}
              active={climaxMs != null}
              title={climaxMs != null
                ? `Climax set at ${formatTime(climaxMs / 1000)} — click to move it here (X). G jumps to it.`
                : 'Set the climax at the current moment (X). G jumps to it.'}
            >
              <ClimaxIcon />
            </ControlButton>
          )}

          {onToggleLoop && (
            <ControlButton
              onClick={onToggleLoop}
              active={loop}
              title={loop ? 'Looping — click to stop (R)' : 'Loop this video (R)'}
            >
              <LoopIcon />
            </ControlButton>
          )}

          <div className="flex-1" />

          <div className="flex items-center gap-1.5">
            <ControlButton
              onClick={toggleMute}
              title={muted ? 'Unmute (M)' : 'Mute (M)'}
            >
              {muted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
            </ControlButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(parseFloat(e.target.value))}
              aria-label="Volume"
              title={`Volume — ${Math.round((muted ? 0 : volume) * 100)}%`}
              className="w-20 accent-emerald-400 cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Scrub preview — the sprite-sheet frame at the hovered time, portaled to
          <body> so it floats above everything. One tile clipped from the grid. */}
      {scrubHover && scrubSprite && scrubSprite.count > 0 && typeof document !== 'undefined' && (() => {
        const idx = Math.max(0, Math.min(scrubSprite.count - 1, Math.floor(scrubHover.timeMs / scrubSprite.intervalMs)));
        const col = idx % scrubSprite.cols;
        const row = Math.floor(idx / scrubSprite.cols);
        return createPortal(
          <div
            className="pointer-events-none fixed z-[200] flex flex-col items-center gap-1"
            style={{ left: scrubHover.x, top: scrubHover.y - 10, transform: 'translate(-50%, -100%)' }}
          >
            <div
              className="rounded-md overflow-hidden ring-1 ring-zinc-600 shadow-2xl bg-black"
              style={{
                width: scrubSprite.tileW,
                height: scrubSprite.tileH,
                backgroundImage: `url(${scrubSprite.url})`,
                backgroundPosition: `-${col * scrubSprite.tileW}px -${row * scrubSprite.tileH}px`,
                backgroundRepeat: 'no-repeat',
              }}
            />
            <div className="text-[11px] tabular-nums text-zinc-100 bg-zinc-950/90 rounded px-1.5 py-0.5 ring-1 ring-zinc-700">
              {formatTime(scrubHover.timeMs / 1000)}
            </div>
          </div>,
          document.body,
        );
      })()}

      {/* Quick scroll-wheel bookmark picker (opt-in via props). Listens on window,
          gated to this container's bottom controls band, so it never blocks the
          real controls. */}
      {onQuickBookmark && (
        <BookmarkWheel
          containerRef={rootRef}
          labels={topBookmarkLabels ?? []}
          getCurrentMs={() => Math.round((videoRef.current?.currentTime ?? 0) * 1000)}
          onCommit={onQuickBookmark}
          onOpen={showControls}
        />
      )}
    </div>
  );
}

// ─── Bits ──────────────────────────────────────────────────────────────────

function ControlButton({ onClick, title, children, active = false }: { onClick: () => void; title: string; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      // Fast double-clicks on seek/play buttons would otherwise raise a native
      // `dblclick` whose target can be the underlying video (cursor drift), and
      // some browsers react to that — swallow it at the button.
      onDoubleClick={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`p-1.5 rounded transition hover:bg-white/10 ${
        active ? 'text-emerald-400 hover:text-emerald-300' : 'text-zinc-100 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function ClimaxIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.4"
         strokeLinecap="round" strokeLinejoin="round">
      {/* A star — marks the peak / climax. Filled follows currentColor. */}
      <path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .8 4.3L8 11.3 4.2 13.3l.8-4.3-3.1-3 4.3-.6L8 1.5z"
            fill="currentColor" fillOpacity="0.25" />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.5"
         strokeLinecap="round" strokeLinejoin="round">
      {/* Two arcs + arrowheads — the repeat glyph. */}
      <path d="M2 8a6 6 0 0 1 10-4.5L14 5M14 8a6 6 0 0 1-10 4.5L2 11" />
      <path d="M14 2.5V5h-2.5M2 13.5V11h2.5" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.5"
         strokeLinecap="round" strokeLinejoin="round">
      {/* Bookmark ribbon with a "+" to signal "add". */}
      <path d="M4 2.5h8v11l-4-2.5-4 2.5v-11Z" />
      <path d="M8 5v3M6.5 6.5h3" />
    </svg>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function PlayIcon() { return (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M5 3l12 7-12 7V3z" /></svg>
); }
function PauseIcon() { return (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
    <rect x="4" y="3" width="4" height="14" rx="1" /><rect x="12" y="3" width="4" height="14" rx="1" />
  </svg>
); }
function SkipBackIcon() { return (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5a5 5 0 1 1-5 5" /><path d="M6 2v4h4" />
    <text x="10" y="13" fontSize="6" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">10</text>
  </svg>
); }
function SkipForwardIcon() { return (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 5a5 5 0 1 0 5 5" /><path d="M14 2v4h-4" />
    <text x="10" y="13" fontSize="6" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">10</text>
  </svg>
); }
function VolumeIcon() { return (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7v6h3l5 4V3L6 7H3z" fill="currentColor" /><path d="M14 7c1.5 1 1.5 5 0 6" /><path d="M16 5c3 2 3 8 0 10" />
  </svg>
); }
function MuteIcon() { return (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7v6h3l5 4V3L6 7H3z" fill="currentColor" /><path d="M14 7l5 5M19 7l-5 5" />
  </svg>
); }
