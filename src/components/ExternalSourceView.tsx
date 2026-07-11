'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { YouTubePlayer } from './YouTubePlayer';

/**
 * The external-source realm: a uniform 16:9 grid of a YouTube channel/playlist's
 * videos (deliberately NOT the masonry — different content, different
 * presentation), with infinite scroll and a click-to-embed player. Self-contained
 * so HomeClient just mounts it when a source is selected.
 */
export function ExternalSourceView({ slug, suspended }: { slug: string; suspended?: boolean }) {
  const source = trpc.externalSource.get.useQuery({ slug });
  const q = trpc.externalSource.items.useInfiniteQuery(
    { slug },
    { getNextPageParam: (last) => last.nextCursor, initialCursor: undefined },
  );
  // Index into `videos` of the video the player queue starts at (null = closed).
  const [playIndex, setPlayIndex] = useState<number | null>(null);

  const videos = q.data?.pages.flatMap((p) => p.items) ?? [];

  // Tail sentinel → fetch the next page as the user nears the end.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchNextPage = q.fetchNextPage;
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !q.hasNextPage || q.isFetchingNextPage) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void fetchNextPage(); },
      { rootMargin: '400px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [q.hasNextPage, q.isFetchingNextPage, fetchNextPage]);

  return (
    <div>
      <div className="mb-4 flex items-end gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-zinc-500 uppercase tracking-wider">External source</div>
          <div className="text-lg text-zinc-100 font-medium truncate">{source.data?.name ?? '…'}</div>
        </div>
        {videos.length > 0 && (
          <button
            onClick={() => setPlayIndex(0)}
            className="shrink-0 inline-flex items-center gap-2 rounded-md bg-emerald-400 hover:bg-emerald-300
                       text-zinc-900 font-medium text-sm px-3 py-1.5 transition"
          >
            <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z" /></svg>
            Play all
          </button>
        )}
      </div>

      {q.isError ? (
        <div className="text-center text-rose-400/90 py-16 text-sm max-w-md mx-auto">
          {q.error?.message ?? 'Failed to load videos.'}
        </div>
      ) : q.isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-video rounded-lg bg-zinc-900 animate-pulse" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <div className="text-center text-zinc-500 py-16 text-sm">No videos in this source.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {videos.map((v, i) => (
            <button key={v.videoId} onClick={() => setPlayIndex(i)} className="group text-left">
              <div className="relative aspect-video rounded-lg overflow-hidden bg-zinc-900 ring-1 ring-transparent group-hover:ring-zinc-600 transition">
                {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" loading="lazy" className="w-full h-full object-cover" />}
                <div className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 group-hover:opacity-100 transition">
                  <PlayGlyph />
                </div>
              </div>
              <div className="mt-1.5 text-sm text-zinc-200 line-clamp-2">{v.title}</div>
              <div className="text-xs text-zinc-500 truncate">{v.channelTitle}</div>
            </button>
          ))}
        </div>
      )}

      <div ref={sentinelRef} className="h-8" />
      {q.isFetchingNextPage && <div className="py-4 text-center text-xs text-zinc-600">Loading more…</div>}

      {playIndex !== null && (
        <YouTubePlayer
          videos={videos.map((v) => ({ videoId: v.videoId, title: v.title }))}
          startIndex={playIndex}
          suspended={suspended}
          onClose={() => setPlayIndex(null)}
        />
      )}
    </div>
  );
}

function PlayGlyph() {
  return (
    <span className="grid place-items-center w-14 h-14 rounded-full bg-black/60 text-white">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
    </span>
  );
}
