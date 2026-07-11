'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Masonry, useInfiniteLoader } from 'masonic';
import { MediaCard } from './MediaCard';

/** Per-item text occurrence match returned by the search router. Drives
 *  the "match at 0:45" tile + viewer auto-seek. Photos with OCR text have
 *  tStartMs=null (no timeline). */
export interface TextMatch {
  source: 'ocr' | 'transcript' | 'bookmark';
  tStartMs: number | null;
  tEndMs: number | null;
  text: string;
}

export interface MediaItemDto {
  id: number;
  uuid: string;
  filename: string;
  kind: 'photo' | 'video';
  width: number | null;
  height: number | null;
  durationMs: number | null;
  capturedAt: number | null;
  capturedPlace: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  sizeBytes: number | null;
  /** The CURRENT user's rating, 0-5. */
  likeCount: number;
  /** Community rating: the average across everyone who's rated this item
   *  (0-5), null when nobody has — "what others think". */
  communityLikeAvg: number | null;
  /** How many users have rated it (context for the average). */
  communityLikeCount: number;
  /** Client-applied rotation override in degrees (0/90/180/270). */
  rotation: number;
  /** Raw sensitive-content scores in [0, 1]. Client compares against the
   *  shared thresholds in `lib/sensitive-thresholds.ts` to decide whether
   *  to show a badge. */
  nsfwScore: number;
  violenceScore: number;
  /** Manual sensitivity override: null = auto-detect, 1 = forced sensitive,
   *  0 = forced safe. Combined with the scores via `effectiveSensitive`. */
  sensitiveOverride: number | null;
  librarySlug: string;
  thumbnailUrl: string;
  previewUrl: string;
  mediaUrl: string;
  scores?: { vector: number; fts: number | null; final: number };
  /** Search-only: top-N occurrence matches for the current query. Empty
   *  when not in a search context. */
  matches?: TextMatch[];
}

export function selectionKey(librarySlug: string, itemUuid: string): string {
  return `${librarySlug}::${itemUuid}`;
}

interface Handlers {
  onSelect: (item: MediaItemDto, match?: TextMatch) => void;
  onToggleSelection?: (item: MediaItemDto, e: React.MouseEvent) => void;
  onSetLikes?: (item: MediaItemDto, count: number) => Promise<void> | void;
  selectionMode?: boolean;
}

// Handlers reach the (masonic-memoized) cells through a STABLE ref in context.
// The ref identity never changes, so cells don't churn; they read `.current`
// lazily on interaction, so there are no stale-closure calls even for cells
// masonic didn't re-render.
const HandlersCtx = createContext<React.MutableRefObject<Handlers> | null>(null);

/** What masonic stores per cell: the item plus its (volatile) selected flag,
 *  baked in so a selection change busts the cell's memo and re-renders it. */
interface Cell { item: MediaItemDto; selected: boolean; }

// Target tile width — bigger on large displays (fewer, larger tiles), which is
// how a virtualized masonry scales up (the old CSS-zoom path can't, it desyncs
// masonic's measurements). masonic derives the column COUNT from this.
function targetColumnWidth(vw: number): number {
  if (vw >= 3000) return 380;
  if (vw >= 2200) return 300;
  if (vw >= 1680) return 240;
  if (vw >= 1024) return 190;
  return 160;
}

function useColumnWidth(): number {
  const [w, setW] = useState(() =>
    typeof window === 'undefined' ? 190 : targetColumnWidth(window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setW(targetColumnWidth(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

function GridCell({ data }: { index: number; data: Cell; width: number }) {
  const ref = useContext(HandlersCtx)!;
  const { item, selected } = data;
  return (
    <MediaCard
      id={item.id}
      uuid={item.uuid}
      librarySlug={item.librarySlug}
      thumbnailUrl={item.thumbnailUrl}
      kind={item.kind}
      filename={item.filename}
      durationMs={item.durationMs}
      width={item.width}
      height={item.height}
      score={item.scores?.final}
      selected={selected}
      selectionMode={ref.current.selectionMode}
      likeCount={item.likeCount}
      communityLikeAvg={item.communityLikeAvg}
      communityLikeCount={item.communityLikeCount}
      rotation={item.rotation}
      nsfwScore={item.nsfwScore}
      violenceScore={item.violenceScore}
      sensitiveOverride={item.sensitiveOverride}
      matches={item.matches}
      onOpen={(match) => ref.current.onSelect(item, match)}
      onToggleSelection={ref.current.onToggleSelection ? (e) => ref.current.onToggleSelection!(item, e) : undefined}
      onSetLikes={ref.current.onSetLikes ? (count) => ref.current.onSetLikes!(item, count) : undefined}
    />
  );
}

interface Props {
  items: MediaItemDto[];
  /** Called when a tile is opened. `match` is set when the tile was a
   *  search hit with a timestamped match, so the parent can seek the
   *  viewer to that point. */
  onSelect: (item: MediaItemDto, match?: TextMatch) => void;
  onToggleSelection?: (item: MediaItemDto, e: React.MouseEvent) => void;
  selectedKeys?: Set<string>;
  selectionMode?: boolean;
  onSetLikes?: (item: MediaItemDto, count: number) => Promise<void> | void;
  loading?: boolean;
  /** Pull the next page when the user scrolls near the end. */
  onLoadMore?: () => void;
  hasMore?: boolean;
  /** Identity of the current result set (view + filters). When it changes we
   *  remount the masonry so positions + scroll reset for the new dataset. */
  resetKey?: string;
}

export function MediaGrid({
  items, onSelect, onToggleSelection, selectedKeys, selectionMode, onSetLikes,
  loading, onLoadMore, hasMore, resetKey,
}: Props) {
  // Latest handlers in a stable ref (see HandlersCtx).
  const handlersRef = useRef<Handlers>({ onSelect, onToggleSelection, onSetLikes, selectionMode });
  handlersRef.current = { onSelect, onToggleSelection, onSetLikes, selectionMode };

  // Bake `selected` into each cell so a selection change re-renders just the
  // affected tiles (identity churn is cheap; unchanged items keep their DTO
  // reference from the query cache, so their memo holds).
  const cells = useMemo<Cell[]>(
    () => items.map((item) => ({
      item,
      selected: selectedKeys?.has(selectionKey(item.librarySlug, item.uuid)) ?? false,
    })),
    [items, selectedKeys],
  );

  const columnWidth = useColumnWidth();

  const maybeLoadMore = useInfiniteLoader(
    async () => { if (hasMore) onLoadMore?.(); },
    { isItemLoaded: (index, loaded) => !hasMore || index < loaded.length, threshold: 16 },
  );

  if (loading && items.length === 0) {
    // Varied-height skeletons so the masonry shape reads while loading.
    const heights = [1, 0.72, 1.4, 1, 0.66, 1.25];
    return (
      <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 2xl:columns-7 gap-2">
        {Array.from({ length: 24 }).map((_, i) => (
          <div
            key={i}
            style={{ aspectRatio: String(heights[i % heights.length]) }}
            className="break-inside-avoid mb-2 rounded-lg bg-zinc-900 animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="text-center text-zinc-500 py-20">
        No results. Try a different search, or index a folder with{' '}
        <code className="text-zinc-300">pnpm indexer &lt;path&gt;</code>.
      </div>
    );
  }

  return (
    <HandlersCtx.Provider value={handlersRef}>
      <Masonry
        // Remount on dataset change so masonic resets positions + scroll.
        key={resetKey ?? 'default'}
        items={cells}
        columnGutter={8}
        columnWidth={columnWidth}
        overscanBy={2}
        itemHeightEstimate={columnWidth}
        itemKey={(d) => d.item.uuid}
        render={GridCell}
        onRender={maybeLoadMore}
      />
    </HandlersCtx.Provider>
  );
}
