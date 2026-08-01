'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSync, useSyncEvent } from '@/lib/sync';
import { flashHud } from '@/lib/action-hud';
import { writeAudioOwner } from '@/lib/audio-owner';
import { ActionHud } from '@/components/ActionHud';
import { EmbedChrome, type EmbedQueueItem } from './EmbedChrome';

// Minimal shape of the Twitch player-embed global.
interface TwitchPlayerInstance {
  setMuted(m: boolean): void;
  play(): void;
  pause(): void;
  getMuted(): boolean;
  getEnded?(): boolean;
  addEventListener(event: string, cb: () => void): void;
  destroy?(): void;
}
interface TwitchGlobal {
  Player: (new (el: string | HTMLElement, opts: Record<string, unknown>) => TwitchPlayerInstance) & { ENDED: string; PLAYING: string };
}
declare global { interface Window { Twitch?: TwitchGlobal } }

let scriptPromise: Promise<TwitchGlobal> | null = null;
function loadTwitch(): Promise<TwitchGlobal> {
  if (typeof window !== 'undefined' && window.Twitch) return Promise.resolve(window.Twitch);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://player.twitch.tv/js/embed/v1.js';
      s.async = true;
      s.onload = () => window.Twitch ? resolve(window.Twitch) : reject(new Error('Twitch embed failed to load'));
      s.onerror = () => reject(new Error('Twitch embed failed to load'));
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/**
 * Fullscreen Twitch player over the embed JS API. Channels play live, VODs by id.
 * `parent` must be the embedding host (read live from window.location.hostname),
 * so this works on localhost and your prod domain with no server config. Queue
 * auto-advance on ENDED (VODs), solo-audio handoff, screensaver suspend.
 */
export function TwitchPlayer({
  videos, startIndex, autoplay = false, suspended, onClose, onProgress,
}: {
  videos: EmbedQueueItem[];
  startIndex: number;
  autoplay?: boolean;
  suspended?: boolean;
  onClose: () => void;
  onProgress?: (index: number, autoplay: boolean) => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const [autoplayNext, setAutoplayNext] = useState(autoplay);
  const [muted, setMuted] = useState(true);
  const playerRef = useRef<TwitchPlayerInstance | null>(null);
  const autoplayRef = useRef(autoplayNext); autoplayRef.current = autoplayNext;
  const indexRef = useRef(index); indexRef.current = index;
  const wasPlayingRef = useRef(false);
  const onProgressRef = useRef(onProgress); onProgressRef.current = onProgress;
  const sync = useSync();
  const current = videos[index];
  const mountId = 'kn-twitch-mount';

  useEffect(() => { onProgressRef.current?.(index, autoplayNext); }, [index, autoplayNext]);

  const advance = useCallback(() => {
    if (indexRef.current < videos.length - 1) setIndex((i) => i + 1);
  }, [videos.length]);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    loadTwitch().then((Twitch) => {
      if (cancelled) return;
      const el = document.getElementById(mountId);
      if (el) el.innerHTML = '';
      const opts: Record<string, unknown> = {
        width: '100%', height: '100%', muted: true, autoplay: true,
        parent: [window.location.hostname],
      };
      // A live channel → `channel`; a VOD → `video`.
      if (current.isLive) opts.channel = current.videoId; else opts.video = current.videoId;
      const p = new Twitch.Player(mountId, opts);
      p.addEventListener(Twitch.Player.ENDED, () => { if (autoplayRef.current) advance(); });
      playerRef.current = p;
      setMuted(true);
    }).catch(() => {});
    return () => { cancelled = true; try { playerRef.current?.destroy?.(); } catch { /* ignore */ } playerRef.current = null; };
  }, [current, advance]);

  useEffect(() => {
    const p = playerRef.current; if (!p) return;
    if (suspended) { wasPlayingRef.current = true; p.pause(); p.setMuted(true); setMuted(true); }
    else if (wasPlayingRef.current) { try { p.play(); } catch { /* ignore */ } }
  }, [suspended]);

  useSyncEvent('audio.unmuted', () => {
    const p = playerRef.current; if (p) { p.setMuted(true); setMuted(true); flashHud('mute'); }
    writeAudioOwner(false); // soloed out → no longer the owner
  });

  const toggleMute = () => {
    const p = playerRef.current; if (!p) return;
    const next = !muted;
    p.setMuted(next); setMuted(next);
    flashHud(next ? 'mute' : 'unmute');
    writeAudioOwner(!next); // keep the cross-reload audio-owner flag accurate
    if (!next) sync.publish({ type: 'audio.unmuted' });
  };

  if (!current) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black">
      <ActionHud />
      <div id={mountId} className="absolute inset-0 [&_iframe]:w-full [&_iframe]:h-full" />
      <EmbedChrome
        items={videos} index={index} muted={muted} autoplayNext={autoplayNext}
        onClose={onClose} onPrev={() => setIndex((i) => Math.max(0, i - 1))} onNext={advance}
        onToggleMute={toggleMute} onToggleAutoplay={() => setAutoplayNext((v) => !v)}
      />
    </div>
  );
}
