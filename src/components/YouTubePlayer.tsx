'use client';

import { useEffect, useRef, useState } from 'react';
import { useSync, useSyncEvent } from '@/lib/sync';
import { flashHud } from '@/lib/action-hud';
import { ActionHud } from './ActionHud';
import { loadYouTubeApi, type YTPlayer } from '@/lib/youtube-iframe';

export interface QueueVideo { videoId: string; title: string }

/**
 * Fullscreen external-video player over the YouTube IFrame API, so it's a
 * first-class citizen of KenNook's control plane:
 *   - Play All / auto-advance through the queue (onStateChange ENDED → next).
 *   - Solo-audio: unmuting publishes `audio.unmuted` (muting every other
 *     window/device); receiving it mutes this player.
 *   - Screensaver: `suspended` pauses + mutes it (audio must not bleed through
 *     the screensaver), then resumes if it was playing.
 * Autoplay policy requires a muted start; the user unmutes deliberately.
 */
export function YouTubePlayer({
  videos,
  startIndex,
  autoplay = false,
  suspended,
  onClose,
  onProgress,
}: {
  videos: QueueVideo[];
  startIndex: number;
  /** Auto-advance to the next video when one ends. Play-All opens with true;
   *  a single clicked video opens with false. Toggleable in-player. */
  autoplay?: boolean;
  suspended?: boolean;
  onClose: () => void;
  /** Reports the current position + autoplay so the parent can offer Resume. */
  onProgress?: (index: number, autoplay: boolean) => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const [autoplayNext, setAutoplayNext] = useState(autoplay);
  const [muted, setMuted] = useState(true);
  const [ready, setReady] = useState(false);
  // Captions on/off — the enabler for muted background news. Persisted so a
  // news-wall stays captioned across sessions.
  const [captions, setCaptions] = useState<boolean>(() =>
    typeof window !== 'undefined' && localStorage.getItem('kennook.yt-captions') === '1');
  const captionsRef = useRef(captions);
  captionsRef.current = captions;

  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const queueRef = useRef(videos);
  queueRef.current = videos;
  const indexRef = useRef(index);
  indexRef.current = index;
  const autoplayRef = useRef(autoplayNext);
  autoplayRef.current = autoplayNext;
  const wasPlayingRef = useRef(false);
  const lastMutedRef = useRef(true);
  // Ref so onProgress's (unstable) identity doesn't retrigger the effect below.
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const sync = useSync();

  const current = videos[index];

  // Report position + autoplay upward so the parent can show a Resume affordance.
  useEffect(() => { onProgressRef.current?.(index, autoplayNext); }, [index, autoplayNext]);

  // Create the player once, on an imperatively-appended node so YT can replace
  // it with its iframe without fighting React's reconciliation.
  useEffect(() => {
    let cancelled = false;
    // Only auto-advance when the toggle is on (read live via ref).
    const advance = () => {
      if (!autoplayRef.current) return;
      const q = queueRef.current;
      const next = indexRef.current + 1;
      if (next < q.length) { setIndex(next); playerRef.current?.loadVideoById(q[next].videoId); }
    };
    void loadYouTubeApi().then((YT) => {
      if (cancelled || !hostRef.current) return;
      const mount = document.createElement('div');
      hostRef.current.appendChild(mount);
      playerRef.current = new YT.Player(mount, {
        videoId: queueRef.current[startIndex]?.videoId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          autoplay: 1, mute: 1, rel: 0, modestbranding: 1, playsinline: 1,
          cc_load_policy: captionsRef.current ? 1 : 0, cc_lang_pref: 'en',
        },
        events: {
          onReady: (e) => { setReady(true); e.target.playVideo(); },
          onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) advance(); },
        },
      });
    });
    return () => { cancelled = true; try { playerRef.current?.destroy(); } catch { /* already gone */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  // Poll the player's ACTUAL mute state and make it the single source of truth,
  // so a solo fires no matter how the user unmuted — our button OR YouTube's own
  // native volume control (the IFrame API has no mute-changed event to hook).
  // A muted→unmuted transition publishes `audio.unmuted` (soloing everything
  // else); the reverse just updates the HUD/state.
  useEffect(() => {
    if (!ready) return;
    const iv = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      const isMuted = p.isMuted();
      if (isMuted === lastMutedRef.current) return;
      lastMutedRef.current = isMuted;
      setMuted(isMuted);
      if (!isMuted) {
        flashHud('unmute');
        sync.publish({ type: 'audio.unmuted' }); // solo — mute everything else
      } else {
        flashHud('mute');
      }
    }, 400);
    return () => window.clearInterval(iv);
  }, [ready, sync]);

  // Solo-audio: another window/device took audio → mute this player. The poll
  // above reconciles the state + HUD.
  useSyncEvent('audio.unmuted', () => { playerRef.current?.mute(); });

  // Apply captions on load and on every video change (loading a new video
  // resets them). Legacy captions module API — best-effort per video.
  useEffect(() => {
    if (!ready) return;
    const p = playerRef.current;
    if (!p) return;
    try {
      if (captions) {
        p.loadModule?.('captions');
        p.loadModule?.('cc');
        p.setOption?.('captions', 'track', { languageCode: 'en' });
        p.setOption?.('cc', 'track', { languageCode: 'en' });
      } else {
        p.setOption?.('captions', 'track', {});
        p.setOption?.('cc', 'track', {});
      }
    } catch { /* captions not available for this video */ }
  }, [captions, index, ready]);

  const toggleCaptions = () => setCaptions((v) => {
    const next = !v;
    try { localStorage.setItem('kennook.yt-captions', next ? '1' : '0'); } catch { /* private mode */ }
    return next;
  });

  // Screensaver: pause + mute while engaged; resume if it was playing.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !ready) return;
    if (suspended) {
      wasPlayingRef.current = p.getPlayerState() === 1; // PLAYING
      p.pauseVideo();
      p.mute();
    } else if (wasPlayingRef.current) {
      wasPlayingRef.current = false;
      p.playVideo();
    }
  }, [suspended, ready]);

  // Our own mute toggle — imperative only; the poll publishes/flashes.
  const toggleMute = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isMuted()) p.unMute();
    else p.mute();
  };

  const go = (i: number) => {
    if (i < 0 || i >= videos.length) return;
    setIndex(i);
    playerRef.current?.loadVideoById(videos[i].videoId);
  };

  const hasPrev = index > 0;
  const hasNext = index < videos.length - 1;

  return (
    <div className="group fixed inset-0 z-[90] bg-black flex flex-col" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* kn-app-scaled grows the chrome on large displays so the controls
          aren't tiny (this overlay is outside the app's normal scaled chrome). */}
      <div className="kn-app-scaled flex items-center gap-3 px-4 py-2 text-sm text-zinc-300">
        {videos.length > 1 && (
          <span className="text-xs text-zinc-500 tabular-nums shrink-0">{index + 1} / {videos.length}</span>
        )}
        {/* Title + "Open on YouTube" grouped on the LEFT, away from the primary
            actions on the right (which were easy to mis-click). */}
        <span className="truncate max-w-[45%]">{current?.title}</span>
        {current && (
          <a href={`https://www.youtube.com/watch?v=${current.videoId}`} target="_blank" rel="noreferrer"
            className="shrink-0 text-zinc-500 hover:text-zinc-200 text-xs">Open on YouTube ↗</a>
        )}
        <div className="flex-1" />
        {videos.length > 1 && (
          <button
            onClick={() => setAutoplayNext((v) => !v)}
            title={autoplayNext ? 'Autoplay on — plays the next video automatically' : 'Autoplay off — stops at the end of this video'}
            className={`shrink-0 text-xs px-2 py-0.5 rounded ring-1 transition
                        ${autoplayNext
                          ? 'text-emerald-300 ring-emerald-500/50 bg-emerald-950/40'
                          : 'text-zinc-400 ring-zinc-700 hover:text-zinc-200'}`}
          >
            Autoplay {autoplayNext ? 'on' : 'off'}
          </button>
        )}
        <button
          onClick={toggleCaptions}
          title={captions ? 'Captions on — great for muted background news' : 'Captions off'}
          className={`shrink-0 text-xs font-semibold px-1.5 py-0.5 rounded ring-1 transition
                      ${captions
                        ? 'text-emerald-300 ring-emerald-500/50 bg-emerald-950/40'
                        : 'text-zinc-400 ring-zinc-700 hover:text-zinc-200'}`}
        >
          CC
        </button>
        <button onClick={toggleMute} title={muted ? 'Unmute (solo)' : 'Mute'}
          className={`shrink-0 px-2 ${muted ? 'text-zinc-400 hover:text-zinc-100' : 'text-emerald-400 hover:text-emerald-300'}`}>
          {muted ? 'Muted' : 'Sound on'}
        </button>
        <button onClick={onClose} title="Close (Esc)" className="shrink-0 text-zinc-400 hover:text-zinc-100 px-2">✕</button>
      </div>

      {/* YT replaces the mounted child of this host with its iframe. */}
      <div ref={hostRef} className="flex-1 min-h-0 [&>*]:w-full [&>*]:h-full" />

      {/* Large hover-revealed queue arrows over the video (keyboard is
          unreliable here — the focused YouTube iframe grabs the arrow keys). */}
      {videos.length > 1 && (
        <>
          <NavArrow side="left" onClick={() => go(index - 1)} disabled={!hasPrev} />
          <NavArrow side="right" onClick={() => go(index + 1)} disabled={!hasNext} />
        </>
      )}

      <ActionHud />
    </div>
  );
}

function NavArrow({ side, onClick, disabled }: { side: 'left' | 'right'; onClick: () => void; disabled: boolean }) {
  if (disabled) return null;
  return (
    <button
      onClick={onClick}
      title={side === 'left' ? 'Previous video' : 'Next video'}
      className={`kn-app-scaled absolute top-1/2 -translate-y-1/2 z-10 ${side === 'left' ? 'left-4' : 'right-4'}
                  w-12 h-12 grid place-items-center rounded-full bg-black/50 hover:bg-black/80 text-white
                  opacity-0 group-hover:opacity-100 transition`}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round">
        {side === 'left' ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
      </svg>
    </button>
  );
}
