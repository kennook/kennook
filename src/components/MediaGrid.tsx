'use client';

import { MediaCard } from './MediaCard';

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
  workspaceSlug: string;
  thumbnailUrl: string;
  previewUrl: string;
  mediaUrl: string;
  scores?: { vector: number; fts: number | null; final: number };
}

export function selectionKey(workspaceSlug: string, itemUuid: string): string {
  return `${workspaceSlug}::${itemUuid}`;
}

interface Props {
  items: MediaItemDto[];
  onSelect: (item: MediaItemDto) => void;
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
          thumbnailUrl={item.thumbnailUrl}
          kind={item.kind}
          filename={item.filename}
          durationMs={item.durationMs}
          score={item.scores?.final}
          selected={selectedKeys?.has(selectionKey(item.workspaceSlug, item.uuid)) ?? false}
          selectionMode={selectionMode}
          likeCount={item.likeCount}
          rotation={item.rotation}
          nsfwScore={item.nsfwScore}
          violenceScore={item.violenceScore}
          onOpen={() => onSelect(item)}
          onToggleSelection={onToggleSelection ? (e) => onToggleSelection(item, e) : undefined}
          onSetLikes={onSetLikes ? (count) => onSetLikes(item, count) : undefined}
        />
      ))}
    </div>
  );
}
