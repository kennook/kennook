'use client';

import { useEffect, useRef, useState } from 'react';
import { isSensitive } from '@/lib/sensitive-thresholds';
import { SparkleBurst } from './SparkleBurst';

// Suppress repeat sparkle bursts within this window — leading-edge so the
// first click in a rate-up gesture fires the visual, the rest don't stack.
const SPARKLE_COOLDOWN_MS = 500;

export const MAX_LIKES = 5;

interface MediaCardProps {
  id: number;
  thumbnailUrl: string;
  kind: 'photo' | 'video';
  filename: string;
  durationMs: number | null;
  score?: number;
  selected?: boolean;
  selectionMode?: boolean;
  likeCount: number;
  /** Client-applied rotation override in degrees (0/90/180/270). */
  rotation?: number;
  nsfwScore?: number;
  violenceScore?: number;
  onOpen: () => void;
  onToggleSelection?: (e: React.MouseEvent) => void;
  onSetLikes?: (count: number) => Promise<void> | void;
}

export function MediaCard({
  thumbnailUrl,
  kind,
  filename,
  durationMs,
  score,
  selected,
  selectionMode,
  likeCount,
  rotation = 0,
  nsfwScore = 0,
  violenceScore = 0,
  onOpen,
  onToggleSelection,
  onSetLikes,
}: MediaCardProps) {
  // Optimistic local override for the heart so clicks feel instant. Clears
  // when the prop (server truth) catches up to it.
  const [optimisticCount, setOptimisticCount] = useState<number | null>(null);
  useEffect(() => {
    if (optimisticCount !== null && optimisticCount === likeCount) {
      setOptimisticCount(null);
    }
  }, [likeCount, optimisticCount]);
  const displayCount = optimisticCount ?? likeCount;

  // Sparkle burst — re-mounted (via the `key` prop) when the leading-edge
  // cooldown allows it. Starts at 0 so the initial paint doesn't fire an
  // unwanted burst on grid mount.
  const [sparkleKey, setSparkleKey] = useState(0);
  const lastSparkleAtRef = useRef(0);

  const handleCardClick = (e: React.MouseEvent) => {
    if (selectionMode && onToggleSelection) onToggleSelection(e);
    else if ((e.metaKey || e.ctrlKey || e.shiftKey) && onToggleSelection) onToggleSelection(e);
    else onOpen();
  };

  const handleHeartClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onSetLikes) return;
    // Click increments, wraps at MAX so the same button can reset to 0.
    const next = displayCount >= MAX_LIKES ? 0 : displayCount + 1;
    setOptimisticCount(next);
    const now = Date.now();
    if (now - lastSparkleAtRef.current > SPARKLE_COOLDOWN_MS) {
      lastSparkleAtRef.current = now;
      setSparkleKey((k) => k + 1);
    }
    try {
      await onSetLikes(next);
    } catch {
      setOptimisticCount(null);
    }
  };

  const checkboxVisible =
    selected || selectionMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';
  const heartVisible = displayCount > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';

  return (
    <div
      className={`group relative aspect-square overflow-hidden rounded-lg bg-zinc-900 transition
                  ${selected ? 'ring-2 ring-emerald-400' : 'hover:ring-2 hover:ring-zinc-500'}`}
    >
      <button
        onClick={handleCardClick}
        className="absolute inset-0 focus:outline-none focus:ring-2 focus:ring-zinc-500 rounded-lg"
      >
        <img
          src={thumbnailUrl}
          alt={filename}
          loading="lazy"
          className={`absolute inset-0 h-full w-full object-cover transition
                      ${selected ? 'scale-95 brightness-75' : 'group-hover:scale-[1.02]'}`}
          style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
        />
      </button>

      {onToggleSelection && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelection(e); }}
          aria-label={selected ? 'Deselect' : 'Select'}
          aria-pressed={selected}
          className={`absolute top-2 left-2 z-10 w-5 h-5 rounded-full transition
                      flex items-center justify-center shrink-0
                      ${checkboxVisible}
                      ${selected
                        ? 'bg-emerald-400 shadow-lg'
                        : 'bg-black/55 backdrop-blur border border-white/50 hover:bg-black/80'}`}
        >
          {selected && (
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="black" strokeWidth="2">
              <path d="M3 6 L5 8 L9 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      )}

      {onSetLikes && (
        <button
          onClick={handleHeartClick}
          aria-label={`Set likes (currently ${displayCount})`}
          title={
            displayCount === 0 ? 'Like (click to add)'
            : displayCount >= MAX_LIKES ? `${MAX_LIKES} likes — click to reset`
            : `${displayCount} like${displayCount === 1 ? '' : 's'} — click for more`
          }
          className={`absolute bottom-2 left-2 z-10 transition
                      flex items-center gap-1 px-1.5 py-0.5 rounded-full
                      bg-black/55 backdrop-blur hover:bg-black/80
                      ${heartVisible}`}
        >
          <span className="relative inline-flex items-center justify-center">
            <Heart filled={displayCount > 0} />
            {sparkleKey > 0 && <SparkleBurst key={sparkleKey} />}
          </span>
          {displayCount > 0 && (
            <span className="text-[10px] font-semibold text-rose-400 tabular-nums">
              {displayCount}
            </span>
          )}
        </button>
      )}

      {kind === 'video' && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1
                        bg-black/70 text-white text-xs px-1.5 py-0.5 rounded">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M1 1 L9 5 L1 9 Z" />
          </svg>
          {durationMs ? formatDuration(durationMs) : 'video'}
        </div>
      )}

      {/* Top-right badges stack: sensitive warning above the search-score
          chip when both apply. Each is independent so either can show
          alone. */}
      <div className="absolute top-2 right-2 flex flex-col items-end gap-1 pointer-events-none">
        {isSensitive(nsfwScore, violenceScore) && (
          <span
            title={`Flagged — nsfw ${(nsfwScore * 100).toFixed(0)}%, violence ${(violenceScore * 100).toFixed(0)}%`}
            className="flex items-center gap-1 bg-amber-950/85 text-amber-300 text-[10px]
                       font-medium px-1.5 py-0.5 rounded-full border border-amber-700/50 backdrop-blur"
          >
            <WarningIcon />
            Sensitive
          </span>
        )}
        {typeof score === 'number' && !selected && (
          <div className="bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
            {(score * 100).toFixed(0)}%
          </div>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent
                      p-2 pb-7 text-xs text-white truncate opacity-0 group-hover:opacity-100 transition
                      pointer-events-none">
        {filename}
      </div>
    </div>
  );
}

function WarningIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l7 12.5H1L8 1.5z" />
      <path d="M8 6v4M8 12v0.5" />
    </svg>
  );
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill={filled ? '#f43f5e' : 'none'}
      stroke={filled ? '#f43f5e' : 'rgba(255,255,255,0.85)'}
      strokeWidth="1.6"
      strokeLinejoin="round"
    >
      <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
    </svg>
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}
