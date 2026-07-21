'use client';

import { useEffect, useState } from 'react';
import type { MediaItemDto } from './MediaGrid';
import { VIEWER_THUMB_H, REEL_TILE_ASPECT } from '@/lib/viewer-thumb';

const TILE_W = VIEWER_THUMB_H * REEL_TILE_ASPECT;
const TILE_STYLE = { width: TILE_W, height: VIEWER_THUMB_H } as const;

// Layout budget for the responsive count below.
const REEL_GAP = 6;         // gap-1.5 between tiles
// Width kept clear on EACH side so the centered strip never overlaps the side
// nav arrows (w-11 at left-4/right-4 ≈ 60px + breathing room).
const SIDE_RESERVE = 84;

/** How many UPCOMING tiles to show so the centered strip doesn't crowd the side
 *  nav arrows or the bottom-left toolbar. Each tile is wide (144px), so a full
 *  strip dominates a narrow / portrait screen — we cap AGGRESSIVELY there (2–3)
 *  on top of the raw geometric fit. Counts the always-shown "now" tile against
 *  the budget; wide landscape screens still get the full UPCOMING_MAX. */
function computeMaxUpcoming(): number {
  if (typeof window === 'undefined') return UPCOMING_MAX;
  const w = window.innerWidth;
  const h = window.innerHeight;

  // Raw fit between the reserved side gutters (upper bound for extreme aspects).
  const avail = w - SIDE_RESERVE * 2;
  const fit = Math.max(0, Math.floor((avail + REEL_GAP) / (TILE_W + REEL_GAP)) - 1);
  let cap = Math.min(UPCOMING_MAX, fit);

  // Hard width tiers — keep the strip short well before it can reach the
  // bottom-left controls on a narrow window.
  if (w < 820) cap = Math.min(cap, 2);
  else if (w < 1100) cap = Math.min(cap, 3);

  // Portrait screens have little horizontal room for a wide strip and the
  // controls sit closer to center — hold it to 2 (narrow) or 3 (wider portrait).
  if (h > w) cap = Math.min(cap, w < 950 ? 2 : 3);

  return cap;
}

function useMaxUpcoming(): number {
  const [count, setCount] = useState(computeMaxUpcoming);
  useEffect(() => {
    const onResize = () => setCount(computeMaxUpcoming());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return count;
}

interface Props {
  /** The currently visible page of items (parent supplies this). */
  items: MediaItemDto[];
  /** Index of the active item within `items`. The reel shows what comes
   *  AFTER this one. */
  currentIndex: number;
  /** Whether the parent can load another page beyond the current `items`. */
  hasMore: boolean;
  /** Jump to a specific item. */
  onSelect: (item: MediaItemDto) => void;
}

// Upper bound on UPCOMING items shown after the "now playing" tile (5 upcoming +
// 1 current = 6). The actual count shrinks on narrow screens — see useMaxUpcoming.
const UPCOMING_MAX = 5;

/**
 * Sticky-feeling film strip across the bottom of the viewer. Layout:
 *
 *   [ now ] [ +1 ] [ +2 ] [ +3 ] [ +4 ] [ +5 ]  (or Next-page tile)
 *
 * The "now" tile is visually distinct (emerald ring, full opacity, "Now"
 * label) so the user understands the strip is "this and what's coming"
 * rather than a bare list of unrelated thumbnails. When the current
 * page is about to run out a dashed "Next page" placeholder gets
 * appended so the user knows more is coming.
 *
 * On a narrow / portrait screen the number of upcoming tiles is reduced hard
 * (to 2–3) so the centered strip doesn't cover the side nav arrows or the
 * bottom-left toolbar (see computeMaxUpcoming).
 *
 * Click any upcoming tile to jump straight to it.
 */
export function ViewerReel({ items, currentIndex, hasMore, onSelect }: Props) {
  const maxUpcoming = useMaxUpcoming();
  if (currentIndex < 0 || currentIndex >= items.length) return null;

  const current = items[currentIndex];
  const upcoming = items.slice(currentIndex + 1, currentIndex + 1 + maxUpcoming);
  const showNextPageTile = upcoming.length < maxUpcoming && hasMore;

  return (
    <div
      className="pointer-events-none flex items-end justify-center gap-1.5"
      role="list"
      aria-label="Now playing and coming up"
      data-component="viewer-reel"
    >
      {/* Now-playing tile — same dimensions as the upcoming thumbs but
          ringed in emerald and labeled "Now" so the connection is clear. */}
      <div
        role="listitem"
        title={`Now — ${current.filename}`}
        style={TILE_STYLE}
        className="relative rounded-md overflow-hidden bg-zinc-900
                   ring-2 ring-emerald-400 shadow-lg"
      >
        <img
          src={current.thumbnailUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover"
          style={current.rotation ? { transform: `rotate(${current.rotation}deg)` } : undefined}
        />
        <span className="absolute top-1 left-1 px-1 py-0.5 rounded
                         bg-emerald-400 text-[8px] font-semibold text-zinc-900 leading-none
                         uppercase tracking-wider">
          Now
        </span>
        {current.kind === 'video' && (
          <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded
                           bg-black/70 text-[8px] text-zinc-100 leading-none">
            ▶
          </span>
        )}
      </div>

      {upcoming.map((item) => (
        <button
          key={`${item.librarySlug}:${item.uuid}`}
          onClick={() => onSelect(item)}
          title={item.filename}
          role="listitem"
          style={TILE_STYLE}
          className="pointer-events-auto group relative rounded-md overflow-hidden
                     bg-zinc-900 ring-1 ring-white/10 hover:ring-2 hover:ring-emerald-400
                     transition-all shadow-lg"
        >
          <img
            src={item.thumbnailUrl}
            alt={item.filename}
            loading="lazy"
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover
                       opacity-70 group-hover:opacity-100 transition-opacity"
            style={item.rotation ? { transform: `rotate(${item.rotation}deg)` } : undefined}
          />
          {item.kind === 'video' && (
            <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded
                             bg-black/70 text-[8px] text-zinc-100 leading-none">
              ▶
            </span>
          )}
        </button>
      ))}

      {showNextPageTile && (
        <div
          role="listitem"
          title="More items are loading on the next page"
          style={TILE_STYLE}
          className="rounded-md border border-dashed border-zinc-500/60
                     bg-zinc-900/40 flex items-center justify-center
                     text-[10px] text-zinc-400 font-medium shadow-lg"
        >
          Next page →
        </div>
      )}
    </div>
  );
}
