'use client';

import { useEffect, useRef, useState } from 'react';
import { effectiveSensitive } from '@/lib/sensitive-thresholds';
import { likeFillColor } from '@/lib/like-colors';
import { SparkleBurst } from './SparkleBurst';
import type { TextMatch } from './MediaGrid';

// Suppress repeat sparkle bursts within this window — leading-edge so the
// first click in a rate-up gesture fires the visual, the rest don't stack.
const SPARKLE_COOLDOWN_MS = 500;

export const MAX_LIKES = 5;

interface MediaCardProps {
  id: number;
  uuid: string;
  librarySlug: string;
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
  /** Manual sensitivity override: null = auto, 1 = forced sensitive, 0 = safe. */
  sensitiveOverride?: number | null;
  /** Search hit text occurrences. When present and the first match has a
   *  timestamp, the tile swaps to the frame-at-timestamp thumbnail and
   *  surfaces a "0:45" badge. */
  matches?: TextMatch[];
  /** Receives the first timestamped match when the tile was opened from a
   *  search hit, so the parent can deep-link the viewer to that time. */
  onOpen: (match?: TextMatch) => void;
  onToggleSelection?: (e: React.MouseEvent) => void;
  onSetLikes?: (count: number) => Promise<void> | void;
}

export function MediaCard({
  uuid,
  librarySlug,
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
  sensitiveOverride = null,
  matches,
  onOpen,
  onToggleSelection,
  onSetLikes,
}: MediaCardProps) {
  // Find the first timestamped match — that's the one we swap the
  // thumbnail to and badge. Photo OCR matches have tStartMs=null and
  // get badged as "text match" without a timestamp.
  const firstTsMatch = matches?.find((m) => m.tStartMs !== null);
  const tileThumb = firstTsMatch && firstTsMatch.source === 'ocr'
    ? `/api/text-frame/${uuid}?t=${firstTsMatch.tStartMs}&lib=${encodeURIComponent(librarySlug)}`
    : thumbnailUrl;
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
    else onOpen(firstTsMatch);
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
          src={tileThumb}
          alt={filename}
          loading="lazy"
          className={`absolute inset-0 h-full w-full object-cover transition
                      ${selected ? 'scale-95 brightness-75' : 'group-hover:scale-[1.02]'}`}
          style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
          // If the frame-at-timestamp 256px JPEG isn't on disk (e.g. legacy
          // occurrences from before enrich-video-text shipped), fall back
          // to the item's main thumbnail.
          onError={(e) => {
            const img = e.currentTarget;
            if (img.src !== thumbnailUrl) img.src = thumbnailUrl;
          }}
        />
      </button>

      {matches && matches.length > 0 && (
        <TextMatchBadge matches={matches} />
      )}

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
            <Heart count={displayCount} />
            {sparkleKey > 0 && <SparkleBurst key={sparkleKey} />}
          </span>
          {displayCount > 0 && (
            <span
              className="text-[10px] font-semibold tabular-nums"
              style={{ color: likeFillColor(displayCount) ?? undefined }}
            >
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
        {effectiveSensitive(nsfwScore, violenceScore, sensitiveOverride) && (
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

function Heart({ count }: { count: number }) {
  const color = likeFillColor(count);
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill={color ?? 'none'}
      stroke={color ?? 'rgba(255,255,255,0.85)'}
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

/**
 * Search-result badge: surfaces "match at 0:45" + an extra-matches counter.
 * Tooltip carries the matched text so the user can preview without clicking.
 * OCR matches show in amber; transcript matches in sky-blue.
 */
function TextMatchBadge({ matches }: { matches: TextMatch[] }) {
  const first = matches[0];
  const extra = matches.length - 1;
  const tone = first.source === 'ocr'
    ? 'bg-amber-500/85 text-zinc-950'
    : 'bg-sky-500/85 text-zinc-950';
  const label = first.tStartMs !== null
    ? formatDuration(first.tStartMs)
    : first.source === 'ocr'
      ? 'text'
      : 'said';
  const tooltip = matches
    .map((m) => `${m.tStartMs !== null ? formatDuration(m.tStartMs) : '—'}: ${m.text}`)
    .join('\n');

  return (
    <div
      className="absolute top-2 left-2 z-10 flex items-center gap-1 pointer-events-none"
      title={tooltip}
    >
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono leading-none ${tone}`}>
        {label}
      </span>
      {extra > 0 && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono leading-none
                         bg-zinc-900/80 text-zinc-200 ring-1 ring-zinc-700">
          +{extra}
        </span>
      )}
    </div>
  );
}
