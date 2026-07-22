'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MasonryScroller, usePositioner, useResizeObserver, useInfiniteLoader, useScrollToIndex } from 'masonic';
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
  /** Face-aware focal point (0..1 of width/height) — centre of the item's
   *  faces, for framing thumbnails + defaulting the viewer's pan. null when the
   *  item has no detected faces. */
  focusX: number | null;
  focusY: number | null;
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

/** What masonic stores per cell: the item plus its (volatile) selected +
 *  highlighted flags, baked in so a change busts the cell's memo. */
interface Cell { item: MediaItemDto; selected: boolean; highlighted: boolean; }

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

// Measure the grid CONTAINER's own width + document offset via a ResizeObserver.
// masonic's built-in <Masonry> only re-measures on WINDOW resize, so it misses
// the sidebar sliding open/closed (which changes the column width without a
// window resize) — the grid would then overflow off-screen. Feeding masonic
// this measured width (via MasonryScroller) fixes that.
function useMeasure(): [RefObject<HTMLDivElement>, { width: number; offset: number; viewportHeight: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState({ width: 0, offset: 0, viewportHeight: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      let offset = 0;
      let node: HTMLElement | null = el;
      while (node) { offset += node.offsetTop || 0; node = node.offsetParent as HTMLElement | null; }
      const width = el.offsetWidth;
      const viewportHeight = window.innerHeight;
      setRect((r) => (r.width === width && r.offset === offset && r.viewportHeight === viewportHeight
        ? r : { width, offset, viewportHeight }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return [ref, rect];
}

/**
 * The masonic-driven body. Split out from MediaGrid so its hooks
 * (usePositioner / useResizeObserver / useScrollToIndex / useInfiniteLoader)
 * never run during SSR — `useResizeObserver` instantiates a `new ResizeObserver`
 * at RENDER time, which throws on the server. MediaGrid only mounts this once it
 * has a measured `width > 0`, which can't happen until the client-side measure
 * effect runs, so the whole component is effectively client-only.
 */
function MasonryBody({
  cells, items, width, columnWidth, resetKey, offset, viewportHeight,
  highlightUuid, scrollSignal, hasMore, onLoadMore, handlersRef,
}: {
  cells: Cell[];
  items: MediaItemDto[];
  width: number;
  columnWidth: number;
  resetKey?: string;
  offset: number;
  viewportHeight: number;
  highlightUuid?: string | null;
  scrollSignal?: number;
  hasMore?: boolean;
  onLoadMore?: () => void;
  handlersRef: React.MutableRefObject<Handlers>;
}) {
  // Recreate the positioner (clearing cached positions) when width / dataset
  // change. ALSO recreate whenever the item count SHRINKS within the same view —
  // masonic caches positions assuming `items` only grows, and throws "No data
  // was found at index N" if the array gets shorter (an item excluded/deleted, or
  // a transient duplicate de-duped). We bump a nonce SYNCHRONOUSLY during render
  // (not in an effect — the crash happens in this same render), so the fresh
  // positioner is used immediately. Growth (infinite scroll) doesn't bump it, so
  // scroll position + cached layout are preserved on the common path.
  const prevLenRef = useRef(cells.length);
  const shrinkNonceRef = useRef(0);
  if (cells.length < prevLenRef.current) shrinkNonceRef.current += 1;
  prevLenRef.current = cells.length;
  const positioner = usePositioner(
    { width, columnWidth, columnGutter: 8 },
    [resetKey ?? '', shrinkNonceRef.current],
  );
  const resizeObserver = useResizeObserver(positioner);

  // Scroll the highlighted tile into view when `scrollSignal` bumps (the grid is
  // virtualized, so masonic's own scroll-to-index is required).
  const scrollToIndex = useScrollToIndex(positioner, {
    element: typeof window !== 'undefined' ? window : null,
    align: 'center',
    height: viewportHeight,
    offset,
  });
  useEffect(() => {
    if (scrollSignal == null || highlightUuid == null) return;
    const idx = items.findIndex((it) => it.uuid === highlightUuid);
    if (idx >= 0) scrollToIndex(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollSignal]);

  const maybeLoadMore = useInfiniteLoader(
    async () => { if (hasMore) onLoadMore?.(); },
    { isItemLoaded: (index, loaded) => !hasMore || index < loaded.length, threshold: 16 },
  );

  return (
    <HandlersCtx.Provider value={handlersRef}>
      <MasonryScroller<Cell>
        offset={offset}
        height={viewportHeight}
        positioner={positioner}
        resizeObserver={resizeObserver}
        items={cells}
        overscanBy={2}
        itemHeightEstimate={columnWidth}
        // Defensive: masonic can call itemKey with an out-of-range index during
        // a dataset transition (a shuffle/filter/library change shrinks `cells`
        // before the positioner resets), so `d` may be momentarily undefined.
        // Fall back to the index rather than crashing on `d.item`.
        itemKey={(d, index) => d?.item?.uuid ?? index}
        render={GridCell}
        onRender={maybeLoadMore}
      />
    </HandlersCtx.Provider>
  );
}

function GridCell({ data }: { index: number; data: Cell; width: number }) {
  const ref = useContext(HandlersCtx)!;
  // Same transient as itemKey: masonic may render a cell whose data is briefly
  // undefined during a dataset swap. Render nothing rather than crash.
  if (!data?.item) return null;
  const { item, selected, highlighted } = data;
  return (
    <MediaCard
      id={item.id}
      uuid={item.uuid}
      highlighted={highlighted}
      librarySlug={item.librarySlug}
      thumbnailUrl={item.thumbnailUrl}
      kind={item.kind}
      filename={item.filename}
      durationMs={item.durationMs}
      width={item.width}
      height={item.height}
      focusX={item.focusX}
      focusY={item.focusY}
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
  /** uuid of the last item opened in the viewer — its tile gets a sky ring. */
  highlightUuid?: string | null;
  /** Bump to scroll the highlighted tile into view (e.g. on viewer close). */
  scrollSignal?: number;
}

export function MediaGrid({
  items, onSelect, onToggleSelection, selectedKeys, selectionMode, onSetLikes,
  loading, onLoadMore, hasMore, resetKey, highlightUuid, scrollSignal,
}: Props) {
  // Latest handlers in a stable ref (see HandlersCtx).
  const handlersRef = useRef<Handlers>({ onSelect, onToggleSelection, onSetLikes, selectionMode });
  handlersRef.current = { onSelect, onToggleSelection, onSetLikes, selectionMode };

  // Bake `selected` + `highlighted` into each cell so a change re-renders just
  // the affected tiles (unchanged items keep their DTO reference, so memo holds).
  const cells = useMemo<Cell[]>(
    () => items.map((item) => ({
      item,
      selected: selectedKeys?.has(selectionKey(item.librarySlug, item.uuid)) ?? false,
      highlighted: highlightUuid != null && item.uuid === highlightUuid,
    })),
    [items, selectedKeys, highlightUuid],
  );

  const columnWidth = useColumnWidth();
  const [measureRef, { width, offset, viewportHeight }] = useMeasure();

  // Varied-height skeletons so the masonry shape reads while loading.
  const skeletonHeights = [1, 0.72, 1.4, 1, 0.66, 1.25];

  // The measure div is ALWAYS rendered so its width is observable even during
  // the loading/empty states — otherwise the first real grid render would see
  // width 0 (and masonic would fall back to full-window width).
  return (
    <div ref={measureRef}>
      {loading && items.length === 0 ? (
        <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 2xl:columns-7 gap-2">
          {Array.from({ length: 24 }).map((_, i) => (
            <div
              key={i}
              style={{ aspectRatio: String(skeletonHeights[i % skeletonHeights.length]) }}
              className="break-inside-avoid mb-2 rounded-lg bg-zinc-900 animate-pulse"
            />
          ))}
        </div>
      ) : !items.length ? (
        <div className="text-center text-zinc-500 py-20">
          No results. Try a different search, or index a folder with{' '}
          <code className="text-zinc-300">pnpm indexer &lt;path&gt;</code>.
        </div>
      ) : width > 0 ? (
        <MasonryBody
          cells={cells}
          items={items}
          width={width}
          columnWidth={columnWidth}
          resetKey={resetKey}
          offset={offset}
          viewportHeight={viewportHeight}
          highlightUuid={highlightUuid}
          scrollSignal={scrollSignal}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          handlersRef={handlersRef}
        />
      ) : null}
    </div>
  );
}
