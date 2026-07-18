'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { YouTubePlayer } from './YouTubePlayer';
import { NativeMediaPlayer } from './players/NativeMediaPlayer';

type Props = { suspended?: boolean } & (
  | { slug: string; category?: undefined }
  | { category: string; slug?: undefined }
);

/**
 * The external-source realm: a uniform 16:9 grid of videos (deliberately NOT the
 * masonry — different content, different presentation) with a click-to-embed
 * player queue. Serves two shapes: a single source's videos (channel/playlist,
 * with infinite scroll), OR a CATEGORY — one tile per single-video/live source
 * in the group, so all the "news" (etc.) live channels sit side by side.
 */
export function ExternalSourceView(props: Props) {
  const { suspended } = props;
  const slug = 'slug' in props ? props.slug : undefined;
  const category = 'category' in props ? props.category : undefined;
  const isCategory = category != null;

  const source = trpc.externalSource.get.useQuery({ slug: slug ?? '' }, { enabled: !!slug });
  const q = trpc.externalSource.items.useInfiniteQuery(
    { slug: slug ?? '' },
    { getNextPageParam: (last) => last.nextCursor, initialCursor: undefined, enabled: !!slug },
  );
  const cq = trpc.externalSource.categoryItems.useQuery(
    { category: category ?? '' },
    { enabled: isCategory },
  );

  // Open player: which video the queue starts at + whether it auto-advances.
  const [player, setPlayer] = useState<{ startIndex: number; autoplay: boolean } | null>(null);
  // Where playback left off when the player was closed — powers "Resume".
  const [resume, setResume] = useState<{ index: number; autoplay: boolean } | null>(null);

  // Each tile needs a STABLE, UNIQUE key. In category mode two sources can point
  // at the same video (or the same live stream added twice), so key by the
  // source slug there; in source mode the videoId is unique within a playlist.
  const videos = isCategory
    ? (cq.data?.items.map((i) => ({ ...i.video, key: i.slug })) ?? [])
    : (q.data?.pages.flatMap((p) => p.items).map((v) => ({ ...v, key: v.videoId })) ?? []);
  const isLoading = isCategory ? cq.isLoading : q.isLoading;
  const isError = isCategory ? cq.isError : q.isError;
  const errorMsg = isCategory ? cq.error?.message : q.error?.message;
  const name = isCategory ? category : source.data?.name;
  const label = isCategory ? 'Category' : 'External source';

  const openAt = (startIndex: number, autoplay: boolean) => {
    setResume(null);            // starting fresh replaces any old resume point
    setPlayer({ startIndex, autoplay });
  };

  // The current / last-played video (by id, robust to the list growing) — used
  // to highlight its tile so you can find where the queue is.
  const currentVideoId = resume != null ? videos[resume.index]?.videoId ?? null : null;

  // Switching source/category is a fresh session — drop any open player +
  // resume point (their indices belong to the previous list).
  useEffect(() => { setPlayer(null); setResume(null); }, [slug, category]);

  // On exiting the player, scroll the highlighted tile into view so continuing
  // the queue doesn't mean hunting for it.
  const currentTileRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!player && currentVideoId) {
      currentTileRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [player, currentVideoId]);

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
          <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
          <div className="text-lg text-zinc-100 font-medium truncate">{name ?? '…'}</div>
        </div>
        {videos.length > 0 && (
          <button
            onClick={() => openAt(0, true)}
            className="kn-app-scaled shrink-0 inline-flex items-center gap-2 rounded-md bg-emerald-400 hover:bg-emerald-300
                       text-zinc-900 font-medium text-sm px-3 py-1.5 transition"
          >
            <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z" /></svg>
            Play all
          </button>
        )}
      </div>

      {isError ? (
        <div className="text-center text-rose-400/90 py-16 text-sm max-w-md mx-auto">
          {errorMsg ?? 'Failed to load videos.'}
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-video rounded-lg bg-zinc-900 animate-pulse" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <div className="text-center text-zinc-500 py-16 text-sm">
          {isCategory ? 'No live channels in this category yet.' : 'No videos in this source.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {videos.map((v, i) => {
            const isCurrent = currentVideoId === v.videoId;
            return (
              <button
                key={v.key}
                ref={isCurrent ? currentTileRef : undefined}
                onClick={() => openAt(i, false)}
                className="group text-left"
              >
                <div className={`relative aspect-video rounded-lg overflow-hidden bg-zinc-900 transition
                                ${isCurrent ? 'ring-2 ring-sky-400' : 'ring-1 ring-transparent group-hover:ring-zinc-600'}`}>
                  {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" loading="lazy" className="w-full h-full object-cover" />}
                  <div className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 group-hover:opacity-100 transition">
                    <PlayGlyph />
                  </div>
                  {isCurrent && (
                    <div className="absolute top-2 left-2 flex items-center gap-1 bg-sky-400 text-zinc-900
                                    text-[10px] font-semibold px-1.5 py-0.5 rounded-full shadow">
                      <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z" /></svg>
                      {player ? 'Playing' : 'Last played'}
                    </div>
                  )}
                </div>
                <div className={`mt-1.5 text-sm line-clamp-2 ${isCurrent ? 'text-sky-300' : 'text-zinc-200'}`}>{v.title}</div>
                <div className="text-xs text-zinc-500 truncate">{v.channelTitle}</div>
              </button>
            );
          })}
        </div>
      )}

      <div ref={sentinelRef} className="h-8" />
      {q.isFetchingNextPage && <div className="py-4 text-center text-xs text-zinc-600">Loading more…</div>}

      {/* Resume bar — reappears after you exit the player mid-session, so you
          don't have to hunt for the video in the grid. Restores position +
          autoplay. */}
      {!player && resume && videos[resume.index] && (
        <div className="kn-app-scaled fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3
                        bg-zinc-900/95 backdrop-blur ring-1 ring-zinc-700 rounded-full pl-4 pr-2 py-2 shadow-2xl">
          <button
            onClick={() => setPlayer({ startIndex: resume.index, autoplay: resume.autoplay })}
            className="flex items-center gap-2 text-sm text-zinc-100"
          >
            <span className="grid place-items-center w-6 h-6 rounded-full bg-sky-400 text-zinc-900">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z" /></svg>
            </span>
            <span className="max-w-[16rem] truncate">
              {resume.autoplay ? 'Resume playing' : 'Resume'}: {videos[resume.index].title}
            </span>
            <span className="text-xs text-zinc-500 tabular-nums">{resume.index + 1}/{videos.length}</span>
          </button>
          <button onClick={() => setResume(null)} title="Dismiss" className="text-zinc-500 hover:text-zinc-200 px-1.5">×</button>
        </div>
      )}

      {player && (() => {
        // Pick the player by the CURRENT item's playerKind — always item-driven so
        // a mixed feed (e.g. a YouTube-RSS with youtube items) plays correctly.
        const kind = videos[player.startIndex]?.playerKind ?? 'youtube';
        const onProgress = (index: number, autoplay: boolean) => setResume({ index, autoplay });
        const onClose = () => setPlayer(null);
        switch (kind) {
          case 'native':
            return (
              <NativeMediaPlayer
                videos={videos.map((v) => ({ mediaUrl: v.mediaUrl ?? '', title: v.title, thumbnailUrl: v.thumbnailUrl, isLive: v.isLive }))}
                startIndex={player.startIndex}
                autoplay={player.autoplay}
                suspended={suspended}
                onProgress={onProgress}
                onClose={onClose}
              />
            );
          case 'youtube':
          default:
            return (
              <YouTubePlayer
                videos={videos.map((v) => ({ videoId: v.videoId, title: v.title }))}
                startIndex={player.startIndex}
                autoplay={player.autoplay}
                suspended={suspended}
                onProgress={onProgress}
                onClose={onClose}
              />
            );
        }
      })()}
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
