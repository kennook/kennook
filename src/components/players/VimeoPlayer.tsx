'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Player from '@vimeo/player';
import { useSync, useSyncEvent } from '@/lib/sync';
import { flashHud } from '@/lib/action-hud';
import { writeAudioOwner } from '@/lib/audio-owner';
import { ActionHud } from '@/components/ActionHud';
import { EmbedChrome, type EmbedQueueItem } from './EmbedChrome';

/**
 * Fullscreen Vimeo player over the official Player SDK — a first-class KenNook
 * citizen: queue auto-advance (SDK 'ended'), solo-audio handoff, screensaver
 * suspend. Muted autoplay start.
 */
export function VimeoPlayer({
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
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const autoplayRef = useRef(autoplayNext); autoplayRef.current = autoplayNext;
  const indexRef = useRef(index); indexRef.current = index;
  const wasPlayingRef = useRef(false);
  const onProgressRef = useRef(onProgress); onProgressRef.current = onProgress;
  const sync = useSync();
  const current = videos[index];

  useEffect(() => { onProgressRef.current?.(index, autoplayNext); }, [index, autoplayNext]);

  const advance = useCallback(() => {
    if (indexRef.current < videos.length - 1) setIndex((i) => i + 1);
  }, [videos.length]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !current) return;
    mount.innerHTML = '';
    const p = new Player(mount, {
      id: Number(current.videoId), autoplay: true, muted: true, controls: true, responsive: true,
    });
    p.on('ended', () => { if (autoplayRef.current) advance(); });
    playerRef.current = p;
    setMuted(true);
    return () => { void p.destroy().catch(() => {}); playerRef.current = null; };
  }, [current, advance]);

  useEffect(() => {
    const p = playerRef.current; if (!p) return;
    if (suspended) {
      p.getPaused().then((paused) => { wasPlayingRef.current = !paused; void p.pause(); void p.setMuted(true); setMuted(true); });
    } else if (wasPlayingRef.current) { void p.play().catch(() => {}); }
  }, [suspended]);

  useSyncEvent('audio.unmuted', () => {
    const p = playerRef.current; if (p) { void p.setMuted(true); setMuted(true); flashHud('mute'); }
    writeAudioOwner(false); // soloed out → no longer the owner
  });

  const toggleMute = () => {
    const p = playerRef.current; if (!p) return;
    const next = !muted;
    void p.setMuted(next); setMuted(next);
    flashHud(next ? 'mute' : 'unmute');
    writeAudioOwner(!next); // keep the cross-reload audio-owner flag accurate
    if (!next) sync.publish({ type: 'audio.unmuted' });
  };

  if (!current) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black">
      <ActionHud />
      <div ref={mountRef} className="absolute inset-0 grid place-items-center [&_iframe]:w-full [&_iframe]:h-full" />
      <EmbedChrome
        items={videos} index={index} muted={muted} autoplayNext={autoplayNext}
        onClose={onClose} onPrev={() => setIndex((i) => Math.max(0, i - 1))} onNext={advance}
        onToggleMute={toggleMute} onToggleAutoplay={() => setAutoplayNext((v) => !v)}
      />
    </div>
  );
}
