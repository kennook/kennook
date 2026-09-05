'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { usePageState } from '@/lib/url-state';
import { usePreference } from '@/lib/preferences';
import { useSync, useSyncEvent } from '@/lib/sync';
import { Screensaver, preloadScreensaverInBackground } from '@/components/Screensaver';
import type { MediaItemDto } from '@/components/MediaGrid';
import { LibrarySwitcher } from '@/components/LibrarySwitcher';
import { MobileViewer } from './MobileViewer';
import { MobileFilterSheet } from './MobileFilterSheet';

const PAGE_SIZE = 60;

// Slideshow dwell bounds (shared `slideshowPhotoMs` preference, same range as
// the desktop `,`/`.` controls). Mobile steps in whole seconds so the readout
// stays clean (6s, 7s…) rather than inheriting the 5.5s default's half-second.
const SLIDESHOW_MIN_MS = 2000;
const SLIDESHOW_MAX_MS = 60000;

type Tab = 'library' | 'playlists' | 'people';

/**
 * Index of the next/previous PHOTO from `from` in direction `dir` (+1 forward,
 * -1 back), wrapping around, or -1 if the list has no photos. The mobile
 * slideshow is images-only — videos are skipped, since on mobile a video hands
 * off to the OS fullscreen player, which owns the screen and would break the
 * auto-advance flow.
 */
function stepPhotoIndex(items: MediaItemDto[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const idx = ((from + dir * step) % n + n) % n;
    if (items[idx]?.kind === 'photo') return idx;
  }
  return -1;
}

/**
 * Mobile root. Two-tab shell (Library / Playlists), full-screen viewer,
 * native lazy-loaded thumbnail grid, and a touch filter sheet. Intentionally
 * NOT a port of the desktop page — keyboard shortcuts and selection mode live
 * in the desktop tree because they don't fit a touch interface. The viewer does
 * offer an images-only slideshow (play/pause in its chrome); videos are skipped
 * because on mobile they hand off to the OS fullscreen player. The screensaver
 * mirrors here (via the shared `screensaver` sync event) but can only be
 * *started* from a desktop shortcut/hot-corner.
 *
 * URL state (search, playlist, filters) is shared with the desktop view via
 * the same `usePageState` hook, so deep links work cross-device.
 */
export function MobileApp() {
  const url = usePageState();
  const [tab, setTab] = useState<Tab>(url.playlist ? 'playlists' : 'library');
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // Collapsible search: a magnifier by default; tapping expands it to a
  // full-width field and hides the other header controls.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Walk-away screensaver. Mobile can't *start* it (no keyboard/hot-corners) —
  // it mirrors whatever a desktop `S`/hot-corner (or another device) triggers,
  // via the shared `screensaver` sync event. The overlay itself is touch-ready
  // (tap-to-dismiss, PIN/password unlock, wake-lock, playsInline).
  const [screensaverOpen, setScreensaverOpen] = useState(false);
  // Images-only slideshow: auto-advance through photos in the open viewer.
  const [slideshow, setSlideshow] = useState(false);
  // Per-photo dwell — shared with the desktop slideshow preference, so a speed
  // set on either surface applies here too.
  const [slideshowPhotoMs, setSlideshowPhotoMs] = usePreference('slideshowPhotoMs');
  // How media fills the viewer — shared with desktop's default-fit preference
  // (per-device). Defaults to 'cover' (fills the screen); the viewer has a toggle.
  const [fit, setFit] = usePreference('defaultFit');
  // Step to the next/previous whole second (dir: +1 slower, -1 faster), clamped.
  const stepSlideshowSpeed = (dir: 1 | -1) => {
    const sec = slideshowPhotoMs / 1000;
    const nextSec = dir > 0 ? Math.floor(sec) + 1 : Math.ceil(sec) - 1;
    setSlideshowPhotoMs(Math.min(SLIDESHOW_MAX_MS, Math.max(SLIDESHOW_MIN_MS, nextSec * 1000)));
  };

  const inPlaylist = !!url.playlist;
  const inSearch = !inPlaylist && url.query !== '';
  // Expanded while the user opened it OR there's an active query to show/edit.
  const searchExpanded = searchOpen || inSearch;
  const collapseSearch = () => { setSearchOpen(false); url.set({ query: '' }); };

  // Focus the field when the user opens search (not when it's expanded merely
  // because a query arrived via a deep link).
  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  // Infinite-scroll queries. Each `pages` entry is one server response;
  // the IntersectionObserver sentinel at the grid's tail triggers
  // fetchNextPage() when it scrolls into view.
  //
  // Filter args carried into every grid query. URL state is the truth;
  // changing it changes the query key so useInfiniteQuery resets to
  // page 0 automatically.
  const filterArgs = {
    kind: url.kind ?? undefined,
    orientation: url.orientation ?? undefined,
    quality: url.quality ?? undefined,
    tags: url.tags.length ? url.tags : undefined,
    mentioned: url.mentioned.length ? url.mentioned : undefined,
    minLikes: url.minLikes ?? undefined,
    watched: url.watched ?? undefined,
    person: url.person ?? undefined,
    sort: url.sort ?? undefined,
    // Seeded-random order when shuffle is on (overrides sort, server-side).
    shuffleSeed: url.shuffle ?? undefined,
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
  // Facet counts for the filter sheet — same drill-down semantics as desktop
  // (each option shows how many results it would yield). Search mode narrows
  // the counts to matches for the current query.
  const facetsQuery = trpc.media.facets.useQuery(
    { ...filterArgs, query: inSearch ? url.query : undefined },
    { enabled: tab === 'library' && !inPlaylist },
  );

  // Active filters shown in the sheet (sort excluded — it's an ordering, not a
  // filter). Drives the Filters button badge + the sheet's "Clear all".
  const activeFilterCount =
    (url.kind !== null ? 1 : 0) +
    (url.watched !== null ? 1 : 0) +
    (url.quality !== null ? 1 : 0) +
    (url.orientation !== null ? 1 : 0) +
    (url.minLikes !== null ? 1 : 0) +
    url.tags.length +
    url.mentioned.length;

  // Shuffle: a random seed gives a stable scrambled order (server-side); null is
  // the normal sorted order. Toggling on mints a fresh seed; off restores sort.
  const isShuffled = url.shuffle != null;
  const toggleShuffle = () =>
    url.set(
      isShuffled
        ? { shuffle: null, shuffleAnchor: null }
        : { shuffle: Math.floor(Math.random() * 2_000_000_000) },
    );

  // ── Screensaver (mirror-only on mobile) ───────────────────────────────────
  const sync = useSync();
  const config = trpc.config.list.useQuery(undefined, { staleTime: 30_000 });
  const screensaverEnabled =
    config.data?.find((c) => c.key === 'screensaver.enabled')?.value ?? true;
  useSyncEvent('config.changed', () => { void trpcUtils.config.list.invalidate(); });

  // The one signal that shows/hides it: a `screensaver` event from any device
  // (desktop shortcut/hot-corner, or another screen). Gated by the instance
  // config so a disabled screensaver can never blank the phone.
  useSyncEvent('screensaver', (e) => {
    setScreensaverOpen(e.open && screensaverEnabled);
  });

  // Exiting (after unlock) turns the wall off everywhere, same as desktop.
  const dismissScreensaver = () => {
    setScreensaverOpen(false);
    sync.publish({ type: 'screensaver', open: false });
  };

  // Join an already-running screensaver on fresh load (the `screensaver` event
  // only fires on change, so a phone that loads late would otherwise miss it).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/sync/state', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { screensaver?: boolean } | null) => {
        if (!cancelled && d?.screensaver && screensaverEnabled) setScreensaverOpen(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Runs once on mount; screensaverEnabled defaults to true until config loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warm the ambient clip during idle so it appears instantly when triggered.
  useEffect(() => preloadScreensaverInBackground(), []);

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

  // A slideshow only makes sense with at least two photos to move between.
  const photoCount = useMemo(
    () => items.reduce((n, i) => n + (i.kind === 'photo' ? 1 : 0), 0),
    [items],
  );
  const canSlideshow = photoCount >= 2;

  // Auto-advance loop. Dwell `slideshowPhotoMs` on each photo, then jump to the
  // next photo (looping the loaded set); land on a video → skip straight past
  // it. Paused while the screensaver is up. Stops on its own if the photos run
  // out (e.g. a filter change emptied the list).
  useEffect(() => {
    if (!slideshow || !selected || screensaverOpen) return;

    const advance = () => {
      const from = items.findIndex((i) => i.uuid === selected.uuid);
      if (from < 0) return;
      const next = stepPhotoIndex(items, from, 1);
      if (next < 0) { setSlideshow(false); return; }
      setSelectedUuid(items[next].uuid);
    };

    if (selected.kind !== 'photo') { advance(); return; } // don't dwell on videos
    const t = window.setTimeout(advance, slideshowPhotoMs);
    return () => window.clearTimeout(t);
  }, [slideshow, selected, screensaverOpen, slideshowPhotoMs, items]);

  // Warm the next photo so it appears instantly on advance instead of flashing
  // a load. Cheap: the browser caches it; the <img> that shows it reuses it.
  useEffect(() => {
    if (!slideshow || !selected) return;
    const from = items.findIndex((i) => i.uuid === selected.uuid);
    if (from < 0) return;
    const next = stepPhotoIndex(items, from, 1);
    const url = next >= 0 ? items[next].previewUrl : null;
    if (url) { const img = new Image(); img.src = url; }
  }, [slideshow, selected, items]);

  // Leaving the viewer ends the slideshow.
  const closeViewer = () => { setSlideshow(false); setSelectedUuid(null); };

  // Manual prev/next for the slideshow transport: photo-aware and wrapping.
  // Changing the selection re-arms the dwell timer, so tapping through resets it.
  const slideshowStep = (dir: 1 | -1) => {
    if (selectedIndex < 0) return;
    const idx = stepPhotoIndex(items, selectedIndex, dir);
    if (idx >= 0) setSelectedUuid(items[idx].uuid);
  };

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
      trpcUtils.media.facets.invalidate();
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
      trpcUtils.media.facets.invalidate();
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
          {showBackButton && (
            <button
              onClick={leavePlaylist}
              aria-label="Back"
              className="w-11 h-11 -ml-1 flex items-center justify-center
                         text-zinc-300 active:bg-zinc-800 rounded-full"
            >
              <ChevronLeftIcon />
            </button>
          )}

          {tab === 'library' && !inPlaylist && (
            searchExpanded ? (
              <>
                <button
                  onClick={collapseSearch}
                  aria-label="Close search"
                  className="w-11 h-11 -ml-1 flex items-center justify-center
                             text-zinc-300 active:bg-zinc-800 rounded-full"
                >
                  <ChevronLeftIcon />
                </button>
                <input
                  ref={searchInputRef}
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
              </>
            ) : (
              <>
                <div className="flex-1" />
                <button
                  onClick={() => setSearchOpen(true)}
                  aria-label="Search"
                  className="w-11 h-11 flex items-center justify-center
                             text-zinc-400 active:bg-zinc-900 rounded-full"
                >
                  <SearchIcon />
                </button>
                <ShuffleButton active={isShuffled} onToggle={toggleShuffle} />
                <FilterButton
                  count={activeFilterCount}
                  onOpen={() => setFilterSheetOpen(true)}
                />
              </>
            )
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

          {/* Hidden while search is expanded so the field gets the whole row. */}
          {!(tab === 'library' && !inPlaylist && searchExpanded) && (
            <LibrarySwitcher hideWhenSingle compact />
          )}
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
        suspended={screensaverOpen}
        slideshow={slideshow}
        canSlideshow={canSlideshow}
        onToggleSlideshow={() => setSlideshow((s) => !s)}
        slideshowMs={slideshowPhotoMs}
        onSlower={() => stepSlideshowSpeed(1)}
        onFaster={() => stepSlideshowSpeed(-1)}
        atMinSpeed={slideshowPhotoMs <= SLIDESHOW_MIN_MS}
        atMaxSpeed={slideshowPhotoMs >= SLIDESHOW_MAX_MS}
        fit={fit}
        onToggleFit={() => setFit(fit === 'cover' ? 'contain' : 'cover')}
        onSlideshowPrev={() => slideshowStep(-1)}
        onSlideshowNext={() => slideshowStep(1)}
        onClose={closeViewer}
        onPrev={onPrev}
        onNext={onNext}
        onSetLikes={handleSetLikes}
        onRotate={handleRotate}
      />

      {filterSheetOpen && (
        <MobileFilterSheet
          facets={facetsQuery.data ?? null}
          relevanceMode={inSearch}
          activeCount={activeFilterCount}
          values={{
            sort: url.sort,
            kind: url.kind,
            watched: url.watched,
            minLikes: url.minLikes,
            quality: url.quality,
            orientation: url.orientation,
            tags: url.tags,
            mentioned: url.mentioned,
          }}
          set={(patch) =>
            // Choosing an explicit sort exits shuffle (otherwise the seed would
            // silently override the sort the user just picked).
            url.set('sort' in patch ? { ...patch, shuffle: null, shuffleAnchor: null } : patch)
          }
          onClose={() => setFilterSheetOpen(false)}
        />
      )}

      <Screensaver open={screensaverOpen} onExit={dismissScreensaver} />
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

function FilterButton({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  const active = count > 0;
  return (
    <button
      onClick={onOpen}
      aria-label="Filters"
      className={`relative h-11 px-4 rounded-full flex items-center gap-1.5 shrink-0 transition
                  ${active
                    ? 'bg-emerald-950/60 text-emerald-400'
                    : 'text-zinc-400 active:bg-zinc-900'}`}
    >
      <FilterIcon />
      {active && (
        <span className="min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-zinc-950
                         text-[10px] font-bold leading-4 text-center tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

function SearchIcon() {
  return (
    <svg
      width="20" height="20" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M13.5 13.5 10.5 10.5" />
    </svg>
  );
}

function ShuffleButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label="Shuffle results"
      aria-pressed={active}
      title={active ? 'Shuffle on — tap to turn off' : 'Shuffle'}
      className={`h-11 w-11 rounded-full flex items-center justify-center shrink-0 transition
                  ${active ? 'bg-emerald-950/60 text-emerald-400' : 'text-zinc-400 active:bg-zinc-900'}`}
    >
      <ShuffleIcon />
    </button>
  );
}

function ShuffleIcon() {
  return (
    <svg
      width="20" height="20" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M2 4h2.5l7 8H14M2 12h2.5l7-8H14" />
      <path d="M12 2.5 14 4l-2 1.5M12 10.5 14 12l-2 1.5" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg
      width="20" height="20" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M2 3h12l-4.5 5.5v4L6.5 14V8.5L2 3z" />
    </svg>
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
