'use client';

import { useEffect, useRef, useState } from 'react';
import { useShortcut } from '@/lib/shortcuts';
import { usePreference } from '@/lib/preferences';
import { useAudioLeader } from '@/lib/audio-leader';
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
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const bufferedRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef<HTMLSpanElement>(null);

  const [playing, setPlaying] = useState(false);
  // Volume stays a cross-tab preference — same global level everywhere.
  // Muted is intentionally LOCAL to this tab: a shared preference races
  // the audio-leader BroadcastChannel (storage event vs message event)
  // and can briefly unmute siblings when the user toggles one window.
  // Per-tab muted closes that race entirely. We seed the initial value
  // from the preference so a user who set "muted by default" still gets
  // a muted first paint.
  const [mutedPrefInitial] = usePreference('videoMuted');
  const [muted, setMuted] = useState<boolean>(mutedPrefInitial);
  const [volume, setVolume] = usePreference('videoVolume');
  const [duration, setDuration] = useState<number | null>(null);

  // Single-audio coordinator. `forceMute` is on when either the
  // screensaver has suppressed everyone, or another player owns the
  // audio token. UI shows the muted icon in that case so the user
  // understands why no sound — clicking unmute claims leadership.
  const audio = useAudioLeader();
  const forceMute = audio.suppressed || (audio.leaderActive && !audio.isLeader);
  const effectiveMuted = muted || forceMute;
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
    if (video.paused) void video.play();
    else video.pause();
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
    // `video.muted` reflects the EFFECTIVE state (may be force-muted by
    // the audio leader or screensaver). If the user clicks the mute icon
    // while in that state, intent is "give THIS player audio" — claim
    // leadership first so the next effect render unblocks the audio.
    const next = !video.muted;
    if (!next && volume === 0) {
      setVolume(0.5);
      video.volume = 0.5;
    }
    if (next) audio.release();
    else      audio.claim();
    video.muted = next;
    setMuted(next);
  }

  function changeVolume(v: number) {
    setVolume(v);
    // Slider drives the muted flag too: dragging to 0 mutes, dragging up
    // from 0 unmutes — keeps the invariant "slider value = audible level".
    if (v === 0 && !muted) setMuted(true);
    else if (v > 0 && muted) setMuted(false);
  }

  // Apply effective mute (preference OR force) + volume to the element
  // whenever any input changes — including the audio-leader / screensaver
  // signals, so another tab claiming audio (or the screensaver opening)
  // mutes this video in the same render.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = effectiveMuted;
    v.volume = volume;
  }, [effectiveMuted, volume]);

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
    // Don't arm the hide timer while the cursor is parked on the controls
    // bar itself; the user is clearly looking at them.
    if (playing && !hoveredControlsRef.current) {
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
        playsInline
        // Honor the persisted mute preference on the initial render of every
        // new video element — covers maxed-toggle remounts and switching items.
        muted={muted}
        onClick={togglePlay}
        onPlay={() => {
          setPlaying(true);
          showControls();
          // Whoever starts playing audibly wins the audio token. If
          // there's already a leader (another tab or this same tab's
          // earlier play), the apply effect will force-mute us instead;
          // we only steal the token when we're actually about to make
          // sound (`effectiveMuted` reflects screensaver + force-mute).
          if (!effectiveMuted) audio.claim();
        }}
        onPause={() => { setPlaying(false); setControlsVisible(true); }}
        onLoadedMetadata={(e) => {
          const dur = e.currentTarget.duration;
          setDuration(dur);
          // Initial seek wins over saved progress — search-result deep-links
          // (?t=ms) explicitly point at a moment the user wants to see; the
          // resume-progress UX would otherwise yank them elsewhere.
          if (initialTimeMs != null && Number.isFinite(initialTimeMs)) {
            const target = Math.max(0, Math.min(dur - 0.1, initialTimeMs / 1000));
            e.currentTarget.currentTime = target;
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
        onTimeUpdate={() => persistProgress(false)}
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
          onMouseDown={startSeekDrag}
          // ::before extends the clickable area 15px above/below the visible
          // bar — events on the pseudo bubble to this host, so the existing
          // handler catches them, and getBoundingClientRect() still reports
          // the visible bar's width so seek math is unchanged. `mb-5` widens
          // the gap to the button row so the 15px slop doesn't intrude on
          // button hit areas.
          // Grow on hover via scaleY (transform — GPU, no layout) instead of a
          // height change (which forced Layout + Paint each frame of the
          // transition). transition-transform also avoids the property-spew of
          // transition-all. The thumb + fills inside scale along with the bar,
          // which on a 6→9px track is visually indistinguishable.
          className="relative h-1.5 hover:scale-y-150 origin-center cursor-pointer mb-6
                     bg-zinc-700/60 rounded-full transition-transform
                     before:content-[''] before:absolute before:-inset-y-[20px] before:inset-x-0"
        >
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
          <div
            ref={thumbRef}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full
                       bg-emerald-400 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ left: '0%' }}
          />
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

          <div className="flex-1" />

          <div className="flex items-center gap-1.5">
            <ControlButton
              onClick={toggleMute}
              title={
                audio.suppressed ? 'Muted (screensaver)'
                : forceMute     ? 'Muted (another video is playing)'
                : effectiveMuted ? 'Unmute (M)'
                : 'Mute (M)'
              }
            >
              {effectiveMuted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
            </ControlButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={effectiveMuted ? 0 : volume}
              onChange={(e) => changeVolume(parseFloat(e.target.value))}
              aria-label="Volume"
              title={`Volume — ${Math.round((effectiveMuted ? 0 : volume) * 100)}%`}
              className="w-20 accent-emerald-400 cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Bits ──────────────────────────────────────────────────────────────────

function ControlButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      // Fast double-clicks on seek/play buttons would otherwise raise a native
      // `dblclick` whose target can be the underlying video (cursor drift), and
      // some browsers react to that — swallow it at the button.
      onDoubleClick={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className="text-zinc-100 hover:text-white p-1.5 rounded transition hover:bg-white/10"
    >
      {children}
    </button>
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
