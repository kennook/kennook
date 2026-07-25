'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSync, useSyncEvent } from '@/lib/sync';
import { flashHud } from '@/lib/action-hud';
import { resumePlayback } from '@/lib/resume-playback';
import { ActionHud } from '@/components/ActionHud';

export interface NativeQueueItem {
  mediaUrl: string;
  title: string;
  thumbnailUrl?: string;
  isLive?: boolean;
}

// `.m3u8`/`.mpd`, OR our CORS proxy which hides the extension and tags `kind=hls`.
const isHls = (url: string) => /\.(m3u8|mpd)(\?|#|$)/i.test(url) || /[?&]kind=hls(&|$)/.test(url);
const isAudio = (url: string) => /\.(mp3|aac|ogg|oga|m4a|flac|wav)(\?|#|$)/i.test(url);

/**
 * Fullscreen native player for external sources whose items are direct media —
 * HLS (m3u8, via lazy-loaded hls.js), progressive video (mp4/webm), or audio
 * (podcasts / radio, shown with artwork). Mirrors YouTubePlayer's control-plane
 * membership: queue auto-advance, solo-audio handoff (unmute mutes every other
 * window/device), and screensaver suspend (pause + mute). Muted autoplay start.
 */
export function NativeMediaPlayer({
  videos, startIndex, autoplay = false, suspended, onClose, onProgress,
}: {
  videos: NativeQueueItem[];
  startIndex: number;
  autoplay?: boolean;
  suspended?: boolean;
  onClose: () => void;
  onProgress?: (index: number, autoplay: boolean) => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const [autoplayNext, setAutoplayNext] = useState(autoplay);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const autoplayRef = useRef(autoplayNext); autoplayRef.current = autoplayNext;
  const indexRef = useRef(index); indexRef.current = index;
  const wasPlayingRef = useRef(false);
  const onProgressRef = useRef(onProgress); onProgressRef.current = onProgress;
  const sync = useSync();

  const current = videos[index];
  const audioOnly = current ? isAudio(current.mediaUrl) : false;

  useEffect(() => { onProgressRef.current?.(index, autoplayNext); }, [index, autoplayNext]);

  const advance = useCallback(() => {
    if (indexRef.current < videos.length - 1) setIndex((i) => i + 1);
  }, [videos.length]);

  // Load the current source into the <video> — hls.js for m3u8, native otherwise.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !current) return;
    setFailed(false);
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;

    const url = current.mediaUrl;
    if (isHls(url) && !el.canPlayType('application/vnd.apple.mpegurl')) {
      // Non-Safari: attach hls.js (lazy — only loaded when an HLS source plays).
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return;
        if (Hls.isSupported()) {
          const h = new Hls({ enableWorker: true });
          h.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setFailed(true); });
          h.loadSource(url);
          h.attachMedia(el);
          hls = h;
        } else { el.src = url; }
      }).catch(() => setFailed(true));
    } else {
      el.src = url;
    }
    el.muted = true;
    setMuted(true);
    void el.play().catch(() => { /* autoplay may be blocked until interaction */ });

    return () => { cancelled = true; if (hls) hls.destroy(); };
  }, [current]);

  // Screensaver suspend → pause + mute; resume if we were playing.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (suspended) {
      wasPlayingRef.current = !el.paused;
      el.pause();
      el.muted = true; setMuted(true);
    } else if (wasPlayingRef.current) {
      // A live stream may have gone stale while the screensaver was up — retry
      // until it re-buffers rather than failing silently.
      resumePlayback(el);
    }
  }, [suspended]);

  // Solo audio: another window/device unmuted → mute us.
  useSyncEvent('audio.unmuted', () => {
    const el = videoRef.current;
    if (el && !el.muted) { el.muted = true; setMuted(true); flashHud('mute'); }
  });

  const togglePlay = () => {
    const el = videoRef.current; if (!el) return;
    if (el.paused) { void el.play(); flashHud('play'); } else { el.pause(); flashHud('pause'); }
  };
  const toggleMute = () => {
    const el = videoRef.current; if (!el) return;
    const next = !el.muted;
    el.muted = next; setMuted(next);
    flashHud(next ? 'mute' : 'unmute');
    if (!next) sync.publish({ type: 'audio.unmuted' }); // solo — mute everyone else
  };

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-[80] bg-black flex items-center justify-center">
      <ActionHud />
      {/* Audio artwork backdrop */}
      {audioOnly && (
        <div className="absolute inset-0 grid place-items-center">
          {current.thumbnailUrl
            ? <img src={current.thumbnailUrl} alt="" className="w-64 h-64 object-cover rounded-xl shadow-2xl opacity-90" />
            : <div className="w-64 h-64 rounded-xl bg-zinc-900 grid place-items-center text-zinc-600"><SpeakerIcon /></div>}
        </div>
      )}

      <video
        ref={videoRef}
        className={`max-w-full max-h-full ${audioOnly ? 'w-0 h-0' : 'w-full h-full object-contain'}`}
        playsInline
        controls={false}
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { if (autoplayRef.current && !current.isLive) advance(); }}
        onError={() => setFailed(true)}
      />

      {failed && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none px-6">
          <div className="text-center text-zinc-300">
            <div className="text-sm font-medium text-zinc-200">This stream couldn&apos;t be played</div>
            <div className="text-xs text-zinc-400 max-w-xs mt-1">The source may be offline, geo-blocked, or not allow embedding (CORS).</div>
          </div>
        </div>
      )}

      {/* Top bar: title + close */}
      <div className="absolute top-0 inset-x-0 flex items-center gap-2 p-3 bg-gradient-to-b from-black/70 to-transparent">
        <div className="min-w-0 flex items-center gap-2">
          {current.isLive && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-600 text-white">LIVE</span>}
          <span className="text-sm text-zinc-100 truncate">{current.title}</span>
          {videos.length > 1 && <span className="text-xs text-zinc-500 tabular-nums shrink-0">{index + 1}/{videos.length}</span>}
        </div>
        <div className="flex-1" />
        <button onClick={onClose} className="text-zinc-300 hover:text-white px-2" aria-label="Close">✕</button>
      </div>

      {/* Bottom controls */}
      <div className="absolute bottom-0 inset-x-0 flex items-center gap-3 p-3 bg-gradient-to-t from-black/80 to-transparent">
        <Ctrl onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} label="Previous">◀</Ctrl>
        <Ctrl onClick={togglePlay} label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '►'}</Ctrl>
        <Ctrl onClick={advance} disabled={index >= videos.length - 1} label="Next">▶</Ctrl>
        <Ctrl onClick={toggleMute} label={muted ? 'Unmute' : 'Mute'}>{muted ? '🔇' : '🔊'}</Ctrl>
        <div className="flex-1" />
        <button
          onClick={() => setAutoplayNext((v) => !v)}
          className={`text-xs px-2 py-1 rounded ring-1 transition ${autoplayNext ? 'text-emerald-300 ring-emerald-700' : 'text-zinc-400 ring-zinc-700'}`}
        >
          Autoplay {autoplayNext ? 'on' : 'off'}
        </button>
      </div>
    </div>
  );
}

function Ctrl({ children, onClick, disabled, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label}
      className="grid place-items-center w-9 h-9 rounded-full bg-white/10 text-zinc-100 hover:bg-white/20 disabled:opacity-30 transition">
      {children}
    </button>
  );
}
function SpeakerIcon() {
  return (<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>);
}
