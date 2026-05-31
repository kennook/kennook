'use client';

import { MediaCard } from './MediaCard';

/** Per-item text occurrence match returned by the search router. Drives
 *  the "match at 0:45" tile + viewer auto-seek. Photos with OCR text have
 *  tStartMs=null (no timeline). */
export interface TextMatch {
  source: 'ocr' | 'transcript';
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
  likeCount: number;
  /** Client-applied rotation override in degrees (0/90/180/270). */
  rotation: number;
  /** Raw sensitive-content scores in [0, 1]. Client compares against the
   *  shared thresholds in `lib/sensitive-thresholds.ts` to decide whether
   *  to show a badge. */
  nsfwScore: number;
  violenceScore: number;
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
}

export function MediaGrid({
  items, onSelect, onToggleSelection, selectedKeys, selectionMode, onSetLikes, loading,
}: Props) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i} className="aspect-square rounded-lg bg-zinc-900 animate-pulse" />
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
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
      {items.map((item) => (
        <MediaCard
          key={item.id}
          id={item.id}
          uuid={item.uuid}
          librarySlug={item.librarySlug}
          thumbnailUrl={item.thumbnailUrl}
          kind={item.kind}
          filename={item.filename}
          durationMs={item.durationMs}
          score={item.scores?.final}
          selected={selectedKeys?.has(selectionKey(item.librarySlug, item.uuid)) ?? false}
          selectionMode={selectionMode}
          likeCount={item.likeCount}
          rotation={item.rotation}
          nsfwScore={item.nsfwScore}
          violenceScore={item.violenceScore}
          matches={item.matches}
          onOpen={(match) => onSelect(item, match)}
          onToggleSelection={onToggleSelection ? (e) => onToggleSelection(item, e) : undefined}
          onSetLikes={onSetLikes ? (count) => onSetLikes(item, count) : undefined}
        />
      ))}
    </div>
  );
}
