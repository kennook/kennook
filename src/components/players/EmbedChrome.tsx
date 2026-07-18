'use client';

import { useEffect } from 'react';

export interface EmbedQueueItem {
  videoId: string;
  title: string;
  isLive?: boolean;
  thumbnailUrl?: string;
}

/**
 * Shared fullscreen chrome for embed-based players (Vimeo, Twitch): a top title
 * bar (LIVE badge + queue position + close) and a bottom control row (prev /
 * next / mute / autoplay). The embed renders its own transport controls inside;
 * this adds KenNook's queue + close + solo-audio affordances around it.
 */
export function EmbedChrome({
  items, index, muted, autoplayNext, onClose, onPrev, onNext, onToggleMute, onToggleAutoplay,
}: {
  items: EmbedQueueItem[];
  index: number;
  muted: boolean;
  autoplayNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleMute: () => void;
  onToggleAutoplay: () => void;
}) {
  const current = items[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!current) return null;

  return (
    <>
      <div className="absolute top-0 inset-x-0 flex items-center gap-2 p-3 bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
        <div className="min-w-0 flex items-center gap-2">
          {current.isLive && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-600 text-white">LIVE</span>}
          <span className="text-sm text-zinc-100 truncate">{current.title}</span>
          {items.length > 1 && <span className="text-xs text-zinc-500 tabular-nums shrink-0">{index + 1}/{items.length}</span>}
        </div>
        <div className="flex-1" />
        <button onClick={onClose} className="pointer-events-auto text-zinc-300 hover:text-white px-2" aria-label="Close">✕</button>
      </div>

      <div className="absolute bottom-0 inset-x-0 flex items-center gap-3 p-3 bg-gradient-to-t from-black/70 to-transparent pointer-events-none">
        <Ctrl onClick={onPrev} disabled={index === 0} label="Previous">◀</Ctrl>
        <Ctrl onClick={onNext} disabled={index >= items.length - 1} label="Next">▶</Ctrl>
        <Ctrl onClick={onToggleMute} label={muted ? 'Unmute' : 'Mute'}>{muted ? '🔇' : '🔊'}</Ctrl>
        <div className="flex-1" />
        <button
          onClick={onToggleAutoplay}
          className={`pointer-events-auto text-xs px-2 py-1 rounded ring-1 transition ${autoplayNext ? 'text-emerald-300 ring-emerald-700' : 'text-zinc-400 ring-zinc-700'}`}
        >
          Autoplay {autoplayNext ? 'on' : 'off'}
        </button>
      </div>
    </>
  );
}

function Ctrl({ children, onClick, disabled, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label}
      className="pointer-events-auto grid place-items-center w-9 h-9 rounded-full bg-white/10 text-zinc-100 hover:bg-white/20 disabled:opacity-30 transition">
      {children}
    </button>
  );
}
