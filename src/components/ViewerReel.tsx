'use client';

import type { MediaItemDto } from './MediaGrid';

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

// Number of UPCOMING items shown after the "now playing" tile.
// 5 upcoming + 1 current = 6 total, same width as before but with the
// current item explicitly indicated.
const UPCOMING_COUNT = 5;

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
 * Click any upcoming tile to jump straight to it.
 */
export function ViewerReel({ items, currentIndex, hasMore, onSelect }: Props) {
  if (currentIndex < 0 || currentIndex >= items.length) return null;

  const current = items[currentIndex];
  const upcoming = items.slice(currentIndex + 1, currentIndex + 1 + UPCOMING_COUNT);
  const showNextPageTile = upcoming.length < UPCOMING_COUNT && hasMore;

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
        className="relative w-20 h-14 rounded-md overflow-hidden bg-zinc-900
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
          key={`${item.workspaceSlug}:${item.uuid}`}
          onClick={() => onSelect(item)}
          title={item.filename}
          role="listitem"
          className="pointer-events-auto group relative w-20 h-14 rounded-md overflow-hidden
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
          className="w-20 h-14 rounded-md border border-dashed border-zinc-500/60
                     bg-zinc-900/40 flex items-center justify-center
                     text-[10px] text-zinc-400 font-medium shadow-lg"
        >
          Next page →
        </div>
      )}
    </div>
  );
}
