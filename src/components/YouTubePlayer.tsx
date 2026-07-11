'use client';

import { useEffect } from 'react';

/**
 * Fullscreen YouTube embed for an external-source video. Thin slice: a plain
 * iframe embed. (A control-surface adapter over the IFrame Player API —
 * play/pause/mute for the future control center — comes in a later pass.)
 */
export function YouTubePlayer({
  videoId,
  title,
  onClose,
}: {
  videoId: string;
  title?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[90] bg-black flex flex-col"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex items-center gap-3 px-4 py-2 text-sm text-zinc-300">
        <span className="flex-1 truncate">{title}</span>
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer"
          className="text-zinc-500 hover:text-zinc-200 text-xs"
        >
          Open on YouTube ↗
        </a>
        <button onClick={onClose} title="Close (Esc)" className="text-zinc-400 hover:text-zinc-100 px-2">✕</button>
      </div>
      <div className="flex-1 min-h-0">
        <iframe
          key={videoId}
          className="w-full h-full"
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`}
          title={title ?? 'YouTube video'}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
    </div>
  );
}
