'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { usePageState } from '@/lib/url-state';
import { useSyncEvent } from '@/lib/sync';
import type { MediaItemDto } from '@/components/MediaGrid';
import { LibrarySwitcher } from '@/components/LibrarySwitcher';
import { KenNookLogo } from '@/components/KenNookLogo';
import { MobileViewer } from './MobileViewer';

const PAGE_SIZE = 60;

type Tab = 'library' | 'playlists' | 'people';

/**
 * Mobile root. Two-tab shell (Library / Playlists), full-screen viewer,
 * native lazy-loaded thumbnail grid. Intentionally NOT a port of the
 * desktop page — keyboard shortcuts, selection mode, filter sidebar,
 * slideshow, and the screensaver shortcut all live in the desktop tree
 * because they don't fit a touch interface.
 *
 * URL state (search, playlist) is shared with the desktop view via the
 * same `usePageState` hook, so deep links work cross-device.
 */
export function MobileApp() {
  const url = usePageState();
  const [tab, setTab] = useState<Tab>(url.playlist ? 'playlists' : 'library');
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [likesSheetOpen, setLikesSheetOpen] = useState(false);

  const inPlaylist = !!url.playlist;
  const inSearch = !inPlaylist && url.query !== '';

  // Infinite-scroll queries. Each `pages` entry is one server response;
  // the IntersectionObserver sentinel at the grid's tail triggers
  // fetchNextPage() when it scrolls into view.
  //
  // Filter args carried into every grid query. URL state is the truth;
  // changing it changes the query key so useInfiniteQuery resets to
  // page 0 automatically.
  const filterArgs = {
    minLikes: url.minLikes ?? undefined,
    person: url.person ?? undefined,
  };
  const recent = trpc.media.list.useInfiniteQuery(
    { limit: PAGE_SIZE, ...filterArgs },
    {
      enabled: tab === 'library' && !inSearch,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      initialCursor: 0,
    },
  );
  const search = trpc.media.search.useInfiniteQuery(
    { query: url.query, limit: PAGE_SIZE, ...filterArgs },
    {
      enabled: tab === 'library' && inSearch,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      initialCursor: 0,
    },
  );
  const playlistQ = trpc.playlist.get.useInfiniteQuery(
    { uuid: url.playlist ?? '', limit: PAGE_SIZE },
    {
      enabled: inPlaylist,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      initialCursor: 0,
    },
  );
  const playlists = trpc.playlist.list.useQuery(undefined, {
    enabled: tab === 'playlists' && !inPlaylist,
  });
  const people = trpc.people.list.useQuery(undefined, {
    enabled: tab === 'people',
  });
  // Light-weight person header (avatar + count). Filtering of the grid
  // is done via filterArgs.person → the queries above already see it.
  const personHeader = trpc.people.get.useQuery(
    { uuid: url.person ?? '', limit: 1, offset: 0 },
    { enabled: !!url.person },
  );

  // Pick the active infinite query so the sentinel + status flags all
  // route to the same source.
  const active = inPlaylist ? playlistQ : inSearch ? search : recent;
  const hasMore = active.hasNextPage ?? false;
  const isFetchingNextPage = active.isFetchingNextPage;
  const fetchNextPage = active.fetchNextPage;

  const items: MediaItemDto[] = useMemo(() => {
    if (inPlaylist) {
      return (playlistQ.data?.pages.flatMap((p) =>
        p.items
          .filter((it) => it.available)
          .map((it) => (it as unknown as { available: true; item: MediaItemDto }).item),
      )) ?? [];
    }
    if (inSearch) return search.data?.pages.flatMap((p) => p.items) ?? [];
    return recent.data?.pages.flatMap((p) => p.items) ?? [];
  }, [inPlaylist, inSearch, playlistQ.data, search.data, recent.data]);

  // Tail sentinel — when the bottom of the grid scrolls into view (with
  // 200px lookahead so we start loading before the user hits the end),
  // pull the next page.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || isFetchingNextPage) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void fetchNextPage();
      },
      { rootMargin: '200px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [hasMore, isFetchingNextPage, fetchNextPage]);

  const selectedIndex = selectedUuid
    ? items.findIndex((i) => i.uuid === selectedUuid)
    : -1;
  const selected = selectedIndex >= 0 ? items[selectedIndex] : null;

  const onPrev = selectedIndex > 0
    ? () => setSelectedUuid(items[selectedIndex - 1].uuid)
    : undefined;
  const onNext = selectedIndex >= 0 && selectedIndex < items.length - 1
    ? () => setSelectedUuid(items[selectedIndex + 1].uuid)
    : undefined;

  // Like flow shared between viewer and list-tap-to-like.
  const trpcUtils = trpc.useUtils();
  const setLikeMutation = trpc.media.setLike.useMutation({
    onSuccess: () => {
      // Invalidate the visible query so the new count shows up. We don't
      // patch surgically here as we do on desktop because the mobile view
      // never has a "watched only" filter that would yank the open item.
      trpcUtils.media.list.invalidate();
      trpcUtils.media.search.invalidate();
      trpcUtils.playlist.get.invalidate();
    },
  });
  const handleSetLikes = async (item: MediaItemDto, count: number) => {
    await setLikeMutation.mutateAsync({
      uuid: item.uuid,
      count,
      librarySlug: item.librarySlug,
    });
  };

  // Rotation: persist server-side via the same mutation as desktop, and
  // invalidate the visible query so the new rotation flows back through
  // the DTO. Mobile doesn't worry about a watched-filter-yanks-viewer
  // race since the mobile viewer is itself driven by selectedUuid.
  const setRotationMutation = trpc.media.setRotation.useMutation({
    onSuccess: () => {
      trpcUtils.media.list.invalidate();
      trpcUtils.media.search.invalidate();
      trpcUtils.playlist.get.invalidate();
    },
  });
  const handleRotate = (item: MediaItemDto, rotation: 0 | 90 | 180 | 270) => {
    setRotationMutation.mutate({
      uuid: item.uuid,
      rotation,
      librarySlug: item.librarySlug,
    });
  };

  // Mark-viewed on open — keeps the watched filter consistent across
  // devices if you ever roll watched filtering into mobile. Deduped per
  // session via a ref so paging through items doesn't spam the endpoint.
  const { mutate: markViewedMutate } = trpc.media.markViewed.useMutation();
  const viewedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selected) return;
    const key = `${selected.librarySlug}:${selected.uuid}`;
    if (viewedRef.current.has(key)) return;
    viewedRef.current.add(key);
    markViewedMutate({ uuid: selected.uuid, librarySlug: selected.librarySlug });
  }, [selected?.uuid, selected?.librarySlug, markViewedMutate]);

  // Cross-device sync: a like on another device, or a playlist mutation
  // from desktop, should be reflected here without a manual refresh.
  // Plain invalidation (rather than a surgical patch) is fine on mobile
  // because we don't have a watched/unwatched filter that would yank the
  // open item out from under the viewer.
  useSyncEvent('item.like', () => {
    trpcUtils.media.list.invalidate();
    trpcUtils.media.search.invalidate();
    trpcUtils.playlist.get.invalidate();
  });
  useSyncEvent('playlist.changed', () => {
    trpcUtils.playlist.list.invalidate();
    trpcUtils.playlist.get.invalidate();
  });

  const onSelectPlaylist = (uuid: string) => {
    url.set({ playlist: uuid, query: '', person: null });
  };
  const leavePlaylist = () => {
    url.set({ playlist: null });
  };
  const onSelectPerson = (uuid: string) => {
    // Selecting a person sends you back to the Library tab with the filter
    // applied — you wanted to *see their photos*, not stay on the list.
    url.set({ person: uuid, playlist: null });
    setTab('library');
  };
  const clearPerson = () => url.set({ person: null });

  const onTabChange = (t: Tab) => {
    if (t === tab) return;
    setTab(t);
    if (t === 'library') url.set({ playlist: null });
  };

  const showBackButton = inPlaylist;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* ── Top bar ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur
                         border-b border-zinc-900
                         pt-[max(env(safe-area-inset-top),0.5rem)]
                         px-3 pb-2">
        <div className="flex items-center gap-2">
          {showBackButton ? (
            <button
              onClick={leavePlaylist}
              aria-label="Back"
              className="w-9 h-9 -ml-1 flex items-center justify-center
                         text-zinc-300 active:bg-zinc-800 rounded-full"
            >
              <ChevronLeftIcon />
            </button>
          ) : (
            <h1 className="shrink-0">
              <KenNookLogo height={22} />
              <span className="sr-only">KenNook</span>
            </h1>
          )}

          {tab === 'library' && !inPlaylist && (
            <>
              <input
                type="search"
                inputMode="search"
                enterKeyHint="search"
                placeholder="Search"
                value={url.query}
                onChange={(e) => url.set({ query: e.target.value })}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md
                           px-3 py-1.5 text-sm placeholder:text-zinc-500
                           focus:border-zinc-600 outline-none"
              />
              <LikesChip
                value={url.minLikes}
                onOpen={() => setLikesSheetOpen(true)}
              />
            </>
          )}

          {inPlaylist && playlistQ.data && (
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                Playlist
              </div>
              <div className="text-sm font-medium truncate">
                {playlistQ.data.pages[0]?.playlist.name ?? ''}
              </div>
            </div>
          )}

          <LibrarySwitcher />
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────── */}
      <main className="flex-1 pb-[calc(56px+env(safe-area-inset-bottom))]">
        {tab === 'playlists' && !inPlaylist ? (
          <PlaylistsList
            playlists={playlists.data ?? []}
            loading={playlists.isLoading}
            onSelect={onSelectPlaylist}
          />
        ) : tab === 'people' ? (
          <PeopleList
            people={people.data ?? []}
            loading={people.isLoading}
            onSelect={onSelectPerson}
          />
        ) : (
          <>
            {url.person && personHeader.data && (
              <PersonStrip
                cover={personHeader.data.person.coverThumbnailUrl}
                name={personHeader.data.person.name}
                photoCount={personHeader.data.totalCount}
                onClear={clearPerson}
              />
            )}
            <Grid
              items={items}
              loading={active.isLoading}
              onTap={(it) => setSelectedUuid(it.uuid)}
            />
            {/* Tail sentinel + footer status. Always rendered so the
                observer is in the DOM as soon as items load. */}
            <div ref={sentinelRef} aria-hidden className="h-px" />
            {(isFetchingNextPage || hasMore) && (
              <div className="text-center text-xs text-zinc-500 py-3">
                {isFetchingNextPage ? 'Loading…' : ''}
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Bottom nav ───────────────────────────────────────────── */}
      <nav
        className="fixed bottom-0 inset-x-0 z-20 bg-zinc-950/95 backdrop-blur
                   border-t border-zinc-900
                   pb-[env(safe-area-inset-bottom)]
                   flex"
      >
        <TabButton
          label="Library"
          active={tab === 'library'}
          onClick={() => onTabChange('library')}
          icon={<LibraryIcon />}
        />
        <TabButton
          label="People"
          active={tab === 'people'}
          onClick={() => onTabChange('people')}
          icon={<PersonIcon />}
        />
        <TabButton
          label="Playlists"
          active={tab === 'playlists'}
          onClick={() => onTabChange('playlists')}
          icon={<PlaylistIcon />}
        />
      </nav>

      <MobileViewer
        item={selected}
        onClose={() => setSelectedUuid(null)}
        onPrev={onPrev}
        onNext={onNext}
        onSetLikes={handleSetLikes}
        onRotate={handleRotate}
      />

      {likesSheetOpen && (
        <LikesSheet
          value={url.minLikes}
          onChange={(v) => url.set({ minLikes: v })}
          onClose={() => setLikesSheetOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────

function Grid({
  items,
  loading,
  onTap,
}: {
  items: MediaItemDto[];
  loading: boolean;
  onTap: (item: MediaItemDto) => void;
}) {
  if (loading && items.length === 0) {
    return <div className="px-4 py-8 text-zinc-500 text-sm">Loading…</div>;
  }
  if (items.length === 0) {
    return <div className="px-4 py-8 text-zinc-500 text-sm">No items.</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-1 p-1">
      {items.map((item) => (
        <button
          key={`${item.librarySlug}:${item.uuid}`}
          onClick={() => onTap(item)}
          className="relative aspect-square overflow-hidden bg-zinc-900
                     active:opacity-80 transition-opacity"
        >
          <img
            src={item.thumbnailUrl}
            alt={item.filename}
            loading="lazy"
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover"
            style={item.rotation ? { transform: `rotate(${item.rotation}deg)` } : undefined}
          />
          {item.kind === 'video' && (
            <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded
                            bg-black/60 text-[10px] text-zinc-100 backdrop-blur">
              VIDEO
            </div>
          )}
          {item.likeCount > 0 && (
            <div className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded
                            bg-black/60 backdrop-blur
                            flex items-center gap-0.5 text-[10px] text-rose-400">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="#f43f5e">
                <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
              </svg>
              {item.likeCount}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

interface PlaylistSummary {
  uuid: string;
  name: string;
  itemCount: number;
  coverThumbnailUrl: string | null;
}

function PlaylistsList({
  playlists,
  loading,
  onSelect,
}: {
  playlists: PlaylistSummary[];
  loading: boolean;
  onSelect: (uuid: string) => void;
}) {
  if (loading) return <div className="px-4 py-8 text-zinc-500 text-sm">Loading…</div>;
  if (playlists.length === 0) {
    return (
      <div className="px-4 py-8 text-zinc-500 text-sm">
        No playlists yet — create one from desktop.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-zinc-900">
      {playlists.map((p) => (
        <li key={p.uuid}>
          <button
            onClick={() => onSelect(p.uuid)}
            className="w-full flex items-center gap-3 px-3 py-3 text-left
                       active:bg-zinc-900"
          >
            <div className="w-12 h-12 rounded bg-zinc-900 overflow-hidden shrink-0">
              {p.coverThumbnailUrl && (
                <img
                  src={p.coverThumbnailUrl}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-zinc-100 truncate">{p.name}</div>
              <div className="text-xs text-zinc-500">
                {p.itemCount} item{p.itemCount === 1 ? '' : 's'}
              </div>
            </div>
            <ChevronRightIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

function TabButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2 flex flex-col items-center gap-0.5 text-[11px]
                  ${active ? 'text-emerald-400' : 'text-zinc-500'}
                  active:bg-zinc-900`}
    >
      {icon}
      {label}
    </button>
  );
}

interface PersonSummary {
  uuid: string;
  name: string | null;
  faceCount: number;
  coverThumbnailUrl: string | null;
}

function PeopleList({
  people,
  loading,
  onSelect,
}: {
  people: PersonSummary[];
  loading: boolean;
  onSelect: (uuid: string) => void;
}) {
  if (loading) return <div className="px-4 py-8 text-zinc-500 text-sm">Loading…</div>;
  if (people.length === 0) {
    return (
      <div className="px-4 py-8 text-zinc-500 text-sm leading-relaxed">
        No people yet. Run face enrichment + clustering from the desktop.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-zinc-900">
      {people.map((p) => (
        <li key={p.uuid}>
          <button
            onClick={() => onSelect(p.uuid)}
            className="w-full flex items-center gap-3 px-3 py-3 text-left active:bg-zinc-900"
          >
            <div className="w-12 h-12 rounded-full bg-zinc-900 overflow-hidden shrink-0">
              {p.coverThumbnailUrl && (
                <img
                  src={p.coverThumbnailUrl}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-zinc-100 truncate">
                {p.name ?? <span className="text-zinc-500 italic">Unnamed</span>}
              </div>
              <div className="text-xs text-zinc-500">
                {p.faceCount} face{p.faceCount === 1 ? '' : 's'}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PersonStrip({
  cover,
  name,
  photoCount,
  onClear,
}: {
  cover: string | null;
  name: string | null;
  photoCount: number;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 mt-2 mx-1
                    bg-zinc-900/70 border border-zinc-800 rounded-lg">
      <div className="w-9 h-9 rounded-full bg-zinc-800 overflow-hidden shrink-0">
        {cover && <img src={cover} alt="" className="w-full h-full object-cover" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">Person</div>
        <div className="text-sm font-medium text-zinc-100 truncate">
          {name ?? <span className="text-zinc-500 italic">Unnamed</span>}
        </div>
        <div className="text-xs text-zinc-500">
          {photoCount} photo{photoCount === 1 ? '' : 's'}
        </div>
      </div>
      <button
        onClick={onClear}
        aria-label="Clear person"
        className="w-8 h-8 flex items-center justify-center text-zinc-400 active:bg-zinc-800 rounded-full"
      >
        ×
      </button>
    </div>
  );
}

function LikesChip({
  value,
  onOpen,
}: {
  value: number | null;
  onOpen: () => void;
}) {
  const active = value !== null;
  return (
    <button
      onClick={onOpen}
      aria-label="Filter by likes"
      className={`h-9 px-2.5 rounded-full flex items-center gap-1 shrink-0 transition
                  ${active
                    ? 'bg-rose-950/60 text-rose-400'
                    : 'text-zinc-400 active:bg-zinc-900'}`}
    >
      <svg
        width="16" height="16" viewBox="0 0 16 16"
        fill={active ? '#f43f5e' : 'none'}
        stroke={active ? '#f43f5e' : 'currentColor'}
        strokeWidth="1.6" strokeLinejoin="round"
      >
        <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
      </svg>
      {active && (
        <span className="text-xs font-semibold tabular-nums">{value}+</span>
      )}
    </button>
  );
}

interface LikesOption { label: string; value: number | null; hearts: number; }
const LIKES_OPTIONS: LikesOption[] = [
  { label: 'Any',       value: null, hearts: 0 },
  { label: '1+',        value: 1,    hearts: 1 },
  { label: '2+',        value: 2,    hearts: 2 },
  { label: '3+',        value: 3,    hearts: 3 },
  { label: '4+',        value: 4,    hearts: 4 },
  { label: 'Top picks', value: 5,    hearts: 5 },
];

function LikesSheet({
  value,
  onChange,
  onClose,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* Backdrop. Tap-to-dismiss; sits below the sheet but above all else. */}
      <button
        onClick={onClose}
        aria-label="Close"
        className="fixed inset-0 z-40 bg-black/70"
      />
      {/* Sheet pinned to bottom, respecting iOS home-indicator inset. */}
      <div
        className="fixed bottom-0 inset-x-0 z-50 bg-zinc-900 rounded-t-2xl
                   border-t border-zinc-800
                   pb-[max(env(safe-area-inset-bottom),0.5rem)]"
      >
        <div className="flex justify-center py-2">
          <div className="w-9 h-1 rounded-full bg-zinc-700" />
        </div>
        <div className="px-4 pb-1">
          <h3 className="text-sm font-medium text-zinc-100">Minimum likes</h3>
        </div>
        <ul>
          {LIKES_OPTIONS.map((opt) => {
            const active = opt.value === value;
            return (
              <li key={opt.label}>
                <button
                  onClick={() => { onChange(opt.value); onClose(); }}
                  className={`w-full flex items-center justify-between px-4 py-3
                              text-sm active:bg-zinc-800
                              ${active ? 'text-emerald-400' : 'text-zinc-100'}`}
                >
                  <span>{opt.label}</span>
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <svg
                        key={i}
                        width="12" height="12" viewBox="0 0 16 16"
                        fill={i < opt.hearts ? '#f43f5e' : 'transparent'}
                        stroke={i < opt.hearts ? '#f43f5e' : 'rgba(255,255,255,0.25)'}
                        strokeWidth="1.4" strokeLinejoin="round"
                      >
                        <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
                      </svg>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────

function ChevronLeftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function LibraryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
function PlaylistIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 6h12M4 12h12M4 18h8" />
      <path d="M19 14l4 3-4 3z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function PersonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </svg>
  );
}
