'use client';

import { useEffect, useRef, useState } from 'react';
import type { MediaItemDto } from './MediaGrid';
import { REEL_TILE_ASPECT } from '@/lib/viewer-thumb';

// Reel tiles are their own (smaller) size now that the strip is a VERTICAL
// column down the left edge rather than the bottom film-strip — a slim column
// so it doesn't cover the media. Decoupled from VIEWER_THUMB_H (which the
// bottom minimap still uses).
const TILE_H = 72;
const TILE_W = Math.round(TILE_H * REEL_TILE_ASPECT); // 3:2 → 108
const TILE_STYLE = { width: TILE_W, height: TILE_H } as const;
const REEL_GAP = 6; // gap-1.5 between stacked tiles

// Never show more than this many tiles even on a very tall display — a wall of
// thumbnails stops being useful.
const TOTAL_MAX = 12;

// Trim the geometric fit by a couple of tiles so the (vertically centered)
// column keeps clear of the controls at the top and bottom edges rather than
// running right up to them.
const CAPACITY_MARGIN = 2;

interface Props {
  /** The currently visible page of items (parent supplies this). */
  items: MediaItemDto[];
  /** Index of the active item within `items`. The reel shows the item just
   *  BEFORE this one (if any), then this one, then what comes AFTER. */
  currentIndex: number;
  /** Whether the parent can load another page beyond the current `items`. */
  hasMore: boolean;
  /** Jump to a specific item. */
  onSelect: (item: MediaItemDto) => void;
}

/**
 * Vertical reel down the LEFT edge of the viewer — a social-media-style column
 * that signals the stream scrolls up/down (prev above, next below), even on
 * desktop. Layout, top to bottom:
 *
 *   [ -1 ]   ← previously viewed (if any); click to go back
 *   [ now ]  ← current, emerald ring + "Now" label
 *   [ +1 ]
 *   [ +2 ]
 *    ...     ← as many UPCOMING as fit the viewer height (responsive)
 *   [ Next page ↓ ]  ← dashed placeholder when the page is about to run out
 *
 * The number of tiles (N) is measured from the column's own height, so it fills
 * a small screen or a large one. Click any tile (prev or upcoming) to jump.
 */
export function ViewerReel({ items, currentIndex, hasMore, onSelect }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  // How many tiles fit in the column's current height — remeasured on resize.
  const [capacity, setCapacity] = useState(TOTAL_MAX);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      // At least 2 (now + one neighbour) even on a short window.
      const fit = Math.max(2, Math.floor((h + REEL_GAP) / (TILE_H + REEL_GAP)) - CAPACITY_MARGIN);
      setCapacity(Math.min(TOTAL_MAX, fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (currentIndex < 0 || currentIndex >= items.length) {
    // Still render the (empty) measured column so capacity is known next time.
    return <div ref={rootRef} className="h-full w-[108px]" aria-hidden />;
  }

  const current = items[currentIndex];
  const previous = currentIndex > 0 ? items[currentIndex - 1] : null;

  // Budget: the column holds `capacity` tiles. Reserve one for "now" and one for
  // the previous tile when it exists; the rest are upcoming (a "next page"
  // placeholder takes one of those slots when we're near the page end).
  const upcomingBudget = Math.max(0, capacity - 1 - (previous ? 1 : 0));
  const upcoming = items.slice(currentIndex + 1, currentIndex + 1 + upcomingBudget);
  const showNextPageTile = upcoming.length < upcomingBudget && hasMore;

  return (
    <div
      ref={rootRef}
      className="pointer-events-none h-full flex flex-col items-start justify-center gap-1.5 overflow-hidden"
      role="list"
      aria-label="Previous, now playing, and coming up"
      data-component="viewer-reel"
    >
      {/* Previously viewed — click to go back. */}
      {previous && (
        <button
          onClick={() => onSelect(previous)}
          title={`Back — ${previous.filename}`}
          role="listitem"
          style={TILE_STYLE}
          className="pointer-events-auto group relative rounded-md overflow-hidden shrink-0
                     bg-zinc-900 ring-1 ring-white/10 hover:ring-2 hover:ring-emerald-400
                     transition-all shadow-lg"
        >
          <img
            src={previous.thumbnailUrl}
            alt={previous.filename}
            loading="lazy"
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover
                       opacity-60 group-hover:opacity-100 transition-opacity"
            style={previous.rotation ? { transform: `rotate(${previous.rotation}deg)` } : undefined}
          />
          <span className="absolute top-1 left-1 px-1 py-0.5 rounded
                           bg-black/70 text-[8px] font-semibold text-zinc-200 leading-none
                           uppercase tracking-wider">
            ↑ Back
          </span>
        </button>
      )}

      {/* Now-playing tile — emerald ring + "Now" label so the connection is clear. */}
      <div
        role="listitem"
        title={`Now — ${current.filename}`}
        style={TILE_STYLE}
        className="relative rounded-md overflow-hidden bg-zinc-900 shrink-0
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
          className="pointer-events-auto group relative rounded-md overflow-hidden shrink-0
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
          className="rounded-md border border-dashed border-zinc-500/60 shrink-0
                     bg-zinc-900/40 flex items-center justify-center
                     text-[10px] text-zinc-400 font-medium shadow-lg"
        >
          Next page ↓
        </div>
      )}
    </div>
  );
}
