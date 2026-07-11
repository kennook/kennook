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
  suspended,
  onClose,
}: {
  videos: QueueVideo[];
  startIndex: number;
  suspended?: boolean;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const [muted, setMuted] = useState(true);
  const [ready, setReady] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const queueRef = useRef(videos);
  queueRef.current = videos;
  const indexRef = useRef(index);
  indexRef.current = index;
  const wasPlayingRef = useRef(false);
  const lastMutedRef = useRef(true);
  const sync = useSync();

  const current = videos[index];

  // Create the player once, on an imperatively-appended node so YT can replace
  // it with its iframe without fighting React's reconciliation.
  useEffect(() => {
    let cancelled = false;
    const advance = () => {
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
        playerVars: { autoplay: 1, mute: 1, rel: 0, modestbranding: 1, playsinline: 1 },
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

  return (
    <div className="fixed inset-0 z-[90] bg-black flex flex-col" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex items-center gap-3 px-4 py-2 text-sm text-zinc-300">
        {videos.length > 1 && (
          <span className="text-xs text-zinc-500 tabular-nums shrink-0">{index + 1} / {videos.length}</span>
        )}
        <span className="flex-1 truncate">{current?.title}</span>
        <button onClick={() => go(index - 1)} disabled={index <= 0} title="Previous"
          className="text-zinc-400 hover:text-zinc-100 disabled:opacity-30 px-1.5">‹</button>
        <button onClick={() => go(index + 1)} disabled={index >= videos.length - 1} title="Next"
          className="text-zinc-400 hover:text-zinc-100 disabled:opacity-30 px-1.5">›</button>
        <button onClick={toggleMute} title={muted ? 'Unmute (solo)' : 'Mute'}
          className={`px-2 ${muted ? 'text-zinc-400 hover:text-zinc-100' : 'text-emerald-400 hover:text-emerald-300'}`}>
          {muted ? 'Muted' : 'Sound on'}
        </button>
        {current && (
          <a href={`https://www.youtube.com/watch?v=${current.videoId}`} target="_blank" rel="noreferrer"
            className="text-zinc-500 hover:text-zinc-200 text-xs">Open on YouTube ↗</a>
        )}
        <button onClick={onClose} title="Close (Esc)" className="text-zinc-400 hover:text-zinc-100 px-2">✕</button>
      </div>
      {/* YT replaces the mounted child of this host with its iframe. */}
      <div ref={hostRef} className="flex-1 min-h-0 [&>*]:w-full [&>*]:h-full" />
      <ActionHud />
    </div>
  );
}
