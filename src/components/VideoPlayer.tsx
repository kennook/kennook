'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShortcut } from '@/lib/shortcuts';
import { usePreference } from '@/lib/preferences';
import { useSync, useSyncEvent } from '@/lib/sync';
import { flashHud } from '@/lib/action-hud';
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
  /** Called once on mount with an imperative handle, so an outside panel (the
   *  bookmark list / trim editor) can seek or read the position without a ref. */
  onApi?: (api: { seek: (ms: number) => void; currentMs: () => number }) => void;
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
  const playedRef = useRef<HTMLDivElement>(null);
  const bufferedRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef<HTMLSpanElement>(null);

  const [playing, setPlaying] = useState(false);
  // Volume *level* stays a cross-tab preference (same loudness everywhere).
  // Mute is per-window and deliberately NOT persisted: a fresh window load
  // always starts muted (also autoplay-policy friendly), and the user unmutes
  // when they want sound. There's no shared mute state worth remembering
  // because unmuting one window mutes all the others (the solo-audio rule).
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = usePreference('videoVolume');
  const [duration, setDuration] = useState<number | null>(null);
  // Hovered bookmark → a tooltip portaled to <body> (escapes the controls
  // bar's stacking context so it can't hide behind the reel/chrome). Null when
  // nothing is hovered. Reset on src change so a stale tip can't linger.
  const [hoverBm, setHoverBm] = useState<{ label: string; timeMs: number; x: number; y: number } | null>(null);
  // Scrubber hover → the sprite-sheet frame preview (portaled). Viewport coords.
  const [scrubHover, setScrubHover] = useState<{ x: number; y: number; timeMs: number } | null>(null);
  useEffect(() => { setHoverBm(null); setScrubHover(null); }, [src]);

  // Solo-audio coordination over the sync layer (same-browser via
  // BroadcastChannel + cross-device via SSE): unmuting THIS window broadcasts
  // `audio.unmuted` so every other window/device mutes; receiving it mutes us.
  // Muting broadcasts nothing — everyone just stays muted until a manual unmute.
  const sync = useSync();
  useSyncEvent('audio.unmuted', () => {
    // Flash the HUD only when we actually LOSE audio (were unmuted) — so a
    // background mute is visible, without flashing every already-muted window.
    setMuted((m) => { if (!m) flashHud('mute'); return true; });
  });
  const applyMute = (next: boolean) => {
    setMuted(next);
    flashHud(next ? 'mute' : 'unmute');
    if (!next) sync.publish({ type: 'audio.unmuted' });
  };
  const [controlsVisible, setControlsVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);
  // True while the cursor is sitting on the controls bar. Holds the idle
  // timer open — without this, resting on a button (no mousemove fires) lets
  // the bar hide right under the cursor, and the next click falls through the
  // bar's pointer-events-none state to the video, toggling play.
  const hoveredControlsRef = useRef(false);

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
    if (video.paused) { void video.play(); flashHud('play'); }
    else { video.pause(); flashHud('pause'); }
  }

  // External pause gate (screensaver). Pause while engaged; on release resume
  // only if the video was actually playing when it engaged, so a user pause
  // survives a screensaver show/dismiss. Keyed on `forcePaused` alone — we
  // sample play state at the transition, not on every render.
  const resumeOnReleaseRef = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (forcePaused) {
      resumeOnReleaseRef.current = !video.paused;
      video.pause();
    } else if (resumeOnReleaseRef.current) {
      resumeOnReleaseRef.current = false;
      void video.play();
    }
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
    // auto-advancing to a new video with no mouse activity to re-arm it.
    // Don't arm while the cursor is parked on the controls bar.
    if (!videoRef.current?.paused && !hoveredControlsRef.current) {
      idleTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2500);
    }
  }

  return (
    <div
      className={`relative group ${className}`}
      onMouseMove={showControls}
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

      <div
        onMouseEnter={() => {
          hoveredControlsRef.current = true;
          if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
          setControlsVisible(true);
        }}
        onMouseLeave={() => {
          hoveredControlsRef.current = false;
          // Resume normal auto-hide once the cursor leaves the bar.
          showControls();
        }}
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
              tags (tooltip is portaled to <body>, see below, so it can't get
              trapped under the reel/chrome by a stacking context); click jumps
              there. The ::before widens the hover/click target beyond the thin
              strip. stopPropagation so the click seeks rather than scrub-drags. */}
          {duration != null && bookmarks?.map((b) => (
            <div
              key={b.id}
              onMouseDown={(e) => {
                e.stopPropagation();
                const v = videoRef.current;
                if (v) { recordSeekPoint(); v.currentTime = b.timestampMs / 1000; }
              }}
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHoverBm({ label: b.label, timeMs: b.timestampMs, x: r.left + r.width / 2, y: r.top });
              }}
              onMouseLeave={() => setHoverBm(null)}
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

      {/* Bookmark tooltip — portaled to <body> so no ancestor stacking context
          (the controls bar's will-change, the strip's transform) can trap it
          under the reel/chrome. Positioned over the hovered strip. */}
      {hoverBm && typeof document !== 'undefined' && createPortal(
        <div
          className="pointer-events-none fixed z-[200] whitespace-nowrap max-w-[260px] overflow-hidden text-ellipsis
                     bg-zinc-950/95 text-zinc-100 text-[11px] leading-none rounded px-2 py-1.5 ring-1 ring-zinc-700 shadow-lg"
          style={{ left: hoverBm.x, top: hoverBm.y - 8, transform: 'translate(-50%, -100%)' }}
        >
          <span className="text-amber-300 tabular-nums mr-1.5">{formatTime(hoverBm.timeMs / 1000)}</span>
          {hoverBm.label || <span className="text-zinc-500">(no tags)</span>}
        </div>,
        document.body,
      )}

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
