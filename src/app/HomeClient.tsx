'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc-client';
import { usePageState } from '@/lib/url-state';
import { SearchBar } from '@/components/SearchBar';
import {
  MediaGrid,
  selectionKey,
  type MediaItemDto,
} from '@/components/MediaGrid';
import { MediaViewer } from '@/components/MediaViewer';
import { ReassignPersonDialog } from '@/components/ReassignPersonDialog';
import { MoveToLibraryDialog } from '@/components/MoveToLibraryDialog';
import { AddToPlaylistDialog } from '@/components/AddToPlaylistDialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FilterStatusBar, type ActiveFilter } from '@/components/FilterStatusBar';
import { SortControl } from '@/components/SortControl';
import { Screensaver, preloadScreensaverInBackground } from '@/components/Screensaver';
import { MobileApp } from '@/components/mobile/MobileApp';
import { KenNookLogo } from '@/components/KenNookLogo';
import { LibrarySwitcher } from '@/components/LibrarySwitcher';
import { SidebarTools } from '@/components/SidebarTools';
import { ShortcutHelp } from '@/components/ShortcutHelp';
import { useIsMobile } from '@/lib/use-media-query';
import { FilterSidebar } from '@/components/FilterSidebar';
import { PlaylistsSection } from '@/components/PlaylistsSection';
import { SourcesSection } from '@/components/SourcesSection';
import { SourcesManager } from '@/components/SourcesManager';
import { ExternalSourceView } from '@/components/ExternalSourceView';
import { SavedSearchesSection } from '@/components/SavedSearchesSection';
import { PeopleSection } from '@/components/PeopleSection';
import { SelectionBar } from '@/components/SelectionBar';
import { useShortcut } from '@/lib/shortcuts';
import { useSync, useSyncEvent } from '@/lib/sync';

interface SelectionRef {
  librarySlug: string;
  itemUuid: string;
}

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;

/** Immutably patch an infinite-query cache ({ pages: [{ items }] }). `mapItem`
 *  returns a replacement for a matching item, or null to leave it unchanged.
 *  Used for the optimistic like/rotation patches so an open viewer isn't yanked
 *  closed by a refetch. */
function patchInfinitePages(
  old: unknown,
  mapItem: (it: Record<string, unknown>) => Record<string, unknown> | null,
): unknown {
  if (!old || typeof old !== 'object') return old;
  const o = old as { pages?: Array<{ items?: Array<Record<string, unknown>> }> };
  if (!Array.isArray(o.pages)) return old;
  let changed = false;
  const pages = o.pages.map((page) => {
    if (!Array.isArray(page.items)) return page;
    let pageChanged = false;
    const items = page.items.map((it) => {
      const mapped = mapItem(it);
      if (mapped == null) return it;
      pageChanged = true;
      changed = true;
      return mapped;
    });
    return pageChanged ? { ...page, items } : page;
  });
  return changed ? { ...o, pages } : old;
}

export default function HomeClient() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <MobileOrDesktop />
    </Suspense>
  );
}

/**
 * Branches at the page root so the mobile and desktop trees stay
 * independent — no `isMobile` checks woven through shared components,
 * no double-mounted queries. Data layer (tRPC, URL state, sync,
 * preferences) is shared because it's UI-agnostic.
 */
function MobileOrDesktop() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileApp /> : <HomeContent />;
}

function HomeContent() {
  const url = usePageState();

  // Selection state lives in the URL — so opening / maximizing / paging
  // through the viewer is bookmarkable and survives browser
  // back/forward. `selectedUuid` is just a derived alias. Writes go
  // through `setSelectedUuid` which mirrors to `url.item`.
  const selectedUuid = url.item;
  const setSelectedUuid = useCallback((uuid: string | null) => {
    url.set({ item: uuid });
  }, [url]);

  // Any open viewer is fullscreen now (the preview modal was retired) — so a
  // bare ?item=X (e.g. an old bookmark with no ?view=) still opens maxed rather
  // than in the dead preview layout. `?view=slideshow` additionally enables the
  // slideshow auto-advance; ?view= otherwise just records the fullscreen intent.
  const viewerMaxed = url.item != null;
  const slideshow = url.view === 'slideshow';
  const setViewerMaxed = useCallback((m: boolean) => {
    // There's no preview modal anymore — items open straight to fullscreen — so
    // "un-maximize" closes the viewer entirely (back to the grid) rather than
    // dropping to a preview. Clears slideshow + any deep-link seek too.
    if (m) url.set({ view: 'full' });
    else url.set({ item: null, view: null, tMs: null });
  }, [url]);

  // Last item opened in the viewer — powers a "Resume" pill + a grid highlight
  // so you can pick up where you left off after closing. `view` remembers
  // whether it was a slideshow.
  const [lastViewed, setLastViewed] = useState<{ uuid: string; view: 'full' | 'slideshow' } | null>(null);
  // Bumped when the viewer closes, to scroll the highlighted tile into view.
  const [scrollSignal, setScrollSignal] = useState(0);
  const prevItemRef = useRef<string | null>(url.item);
  useEffect(() => {
    if (url.item) setLastViewed({ uuid: url.item, view: slideshow ? 'slideshow' : 'full' });
    // Viewer just closed (had an item, now none) → scroll to where we were.
    if (prevItemRef.current != null && url.item == null) setScrollSignal((n) => n + 1);
    prevItemRef.current = url.item;
  }, [url.item, slideshow]);

  // Transient (non-URL) state.
  const [helpOpen, setHelpOpen] = useState(false);
  const [selection, setSelection] = useState<SelectionRef[]>([]);
  const [anchor, setAnchor] = useState<SelectionRef | null>(null);
  // Walk-away screensaver. Triggered by `S` shortcut, exits on any input.
  const [screensaverOpen, setScreensaverOpen] = useState(false);
  // Post-screensaver "quiet" state: when true, page chrome (header, sidebar,
  // viewer chrome) fades to a low-opacity, non-interactive state. Cleared on
  // the first real user input (mouse move / key / wheel / touch).
  const [quietMode, setQuietMode] = useState(false);
  // Collapsible filters/facets sidebar. Default open; persisted per-browser.
  // Hydrated from localStorage after mount to avoid an SSR/client mismatch.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Sub-sidebar: the external-sources manager slides over the sidebar column as
  // a second layer (no backdrop — a "Back" link returns to the main content).
  const [sourcesOpen, setSourcesOpen] = useState(false);
  useEffect(() => {
    const v = localStorage.getItem('kennook.sidebar-open');
    if (v !== null) setSidebarOpen(v === '1');
  }, []);
  const toggleSidebar = () => setSidebarOpen((v) => {
    const next = !v;
    try { localStorage.setItem('kennook.sidebar-open', next ? '1' : '0'); } catch { /* private mode */ }
    return next;
  });

  // Results per page — user-adjustable, persisted per-browser. Default 100.
  // Hydrated after mount to avoid an SSR/client mismatch.
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  useEffect(() => {
    const v = Number(localStorage.getItem('kennook.page-size'));
    if (PAGE_SIZE_OPTIONS.includes(v as (typeof PAGE_SIZE_OPTIONS)[number])) setPageSize(v);
  }, []);
  const changePageSize = (n: number) => {
    setPageSize(n);
    try { localStorage.setItem('kennook.page-size', String(n)); } catch { /* private mode */ }
    // Changing the batch size changes the query key, so the infinite query
    // resets to the first page on its own — nothing else to do here.
  };

  // Enable the sidebar slide transitions only AFTER the first paint, so the
  // initial localStorage-driven open/closed state snaps into place without an
  // unwanted animate-on-load. User toggles thereafter slide smoothly.
  const [sidebarAnimate, setSidebarAnimate] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setSidebarAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const slideClass = sidebarAnimate ? 'transition-[width,margin] duration-300 ease-in-out' : '';

  const selectedKeys = useMemo(
    () => new Set(selection.map((s) => selectionKey(s.librarySlug, s.itemUuid))),
    [selection],
  );

  useShortcut('global.help', () => setHelpOpen((v) => !v));

  // ── Cross-session sync ──────────────────────────────────────────────
  //
  // BroadcastChannel covers same-browser tabs; SSE covers cross-device.
  // Locally-initiated changes don't need to listen to their own echoes
  // (sync.tsx filters by sessionId).
  const sync = useSync();

  // Instance config (admin Configuration page). `screensaver.enabled` gates
  // whether the walk-away screensaver can be triggered at all. Refetched live
  // when an admin flips a toggle (config.changed sync event).
  const config = trpc.config.list.useQuery(undefined, { staleTime: 30_000 });
  const screensaverEnabled =
    config.data?.find((c) => c.key === 'screensaver.enabled')?.value ?? true;
  const utils = trpc.useUtils();
  useSyncEvent('config.changed', () => { void utils.config.list.invalidate(); });

  const triggerScreensaver = () => {
    if (!screensaverEnabled) return; // disabled in admin Configuration
    setScreensaverOpen(true);
    sync.publish({ type: 'screensaver', open: true });
  };
  const dismissScreensaver = () => {
    setScreensaverOpen(false);
    setQuietMode(true);
    sync.publish({ type: 'screensaver', open: false });
  };

  useShortcut('global.screensaver', triggerScreensaver);

  // Screensaver toggles arrive here from every source: same-process devices via
  // SSE, same-browser tabs via BroadcastChannel, and cross-process (caddy fronts
  // the prod :3001 AND dev :3000 builds, whose in-memory brokers don't talk) via
  // the sync broker's leader-only poll of the shared user.db — all normalized to
  // this one `screensaver` event, so there's no per-tab poll here anymore.
  useSyncEvent('screensaver', (e) => {
    setScreensaverOpen(e.open && screensaverEnabled);
  });

  // While quiet mode is on, any real user input wakes the page back up.
  // Listeners attach only when quietMode flips true so we're not paying for
  // global event subscriptions in the common case. `passive: true` keeps us
  // off the scroll/wheel hot path.
  useEffect(() => {
    if (!quietMode) return;
    const wake = () => setQuietMode(false);
    window.addEventListener('mousemove', wake, { passive: true });
    window.addEventListener('keydown', wake, { passive: true });
    window.addEventListener('wheel', wake, { passive: true });
    window.addEventListener('touchstart', wake, { passive: true });
    return () => {
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('keydown', wake);
      window.removeEventListener('wheel', wake);
      window.removeEventListener('touchstart', wake);
    };
  }, [quietMode]);

  // A like on another device — patch our caches the same way the local
  // mutation does. No refetch, no risk of dismissing an open viewer.
  useSyncEvent('item.like', (e) => {
    applyLikePatch(e.uuid, e.count);
    trpcUtils.media.facets.invalidate();
  });

  useSyncEvent('item.rotation', (e) => {
    applyRotationPatch(e.uuid, e.rotation);
  });

  // An item was excluded elsewhere — drop it from our caches, and close the
  // viewer if we happen to have it open.
  useSyncEvent('item.excluded', (e) => {
    trpcUtils.media.list.invalidate();
    trpcUtils.media.search.invalidate();
    trpcUtils.media.similar.invalidate();
    trpcUtils.media.facets.invalidate();
    trpcUtils.playlist.get.invalidate();
    if (url.item === e.uuid) setSelectedUuid(null);
  });

  // Items were moved to another library elsewhere — drop them from our source
  // grids (re-indexing in the target is async, so nothing to add here).
  useSyncEvent('items.moved', () => {
    trpcUtils.media.list.invalidate();
    trpcUtils.media.search.invalidate();
    trpcUtils.media.similar.invalidate();
    trpcUtils.media.facets.invalidate();
    trpcUtils.playlist.get.invalidate();
  });

  // A sensitivity override anywhere — refetch lists/facets (items can enter or
  // leave a sensitivity-filtered view) and the open item's details (the badge).
  useSyncEvent('item.sensitive', () => {
    trpcUtils.media.list.invalidate();
    trpcUtils.media.search.invalidate();
    trpcUtils.media.similar.invalidate();
    trpcUtils.media.facets.invalidate();
    trpcUtils.media.getDetails.invalidate();
  });

  // A tag change anywhere — invalidate the affected item's details (which
  // carries the tag list) and the tag facet.
  useSyncEvent('item.tag.changed', () => {
    trpcUtils.media.getDetails.invalidate();
    trpcUtils.media.facets.invalidate();
  });

  // A playlist mutation anywhere — refresh the sidebar list, and the
  // currently-open playlist if we're viewing one.
  useSyncEvent('playlist.changed', () => {
    trpcUtils.playlist.list.invalidate();
    trpcUtils.playlist.get.invalidate();
  });

  // A saved search was created/deleted on another tab — refresh the list.
  useSyncEvent('savedSearch.changed', () => {
    trpcUtils.savedSearch.list.invalidate();
  });

  // Any per-user sidebar list changed — a playlist / saved search / external
  // source, in-process (via the event) or on another DEVICE (via the poll).
  // Refetch every sidebar list so it appears without a reload.
  useSyncEvent('data.changed', () => {
    trpcUtils.playlist.list.invalidate();
    trpcUtils.playlist.get.invalidate();
    trpcUtils.savedSearch.list.invalidate();
    trpcUtils.externalSource.list.invalidate();
  });

  // Quietly warm the browser cache with the screensaver video during idle
  // time so the first trigger plays instantly. ~1.4MB for 1080p.
  useEffect(() => preloadScreensaverInBackground(), []);

  // An external source (YouTube) takes over the whole view — the internal
  // library modes below are all suppressed while one is selected.
  const inCategory = url.category != null;
  const inExternal = !inCategory && url.source != null;
  const externalMode = inCategory || inExternal; // either external realm view

  // View modes derived from URL — playlist > similar > search > recent.
  const inPlaylist = !externalMode && !!url.playlist;
  const inSimilar = !externalMode && !inPlaylist && !!url.similar;
  const inSearch = !externalMode && !inPlaylist && !inSimilar && url.query !== '';
  const inRecent = !externalMode && !inPlaylist && !inSimilar && !inSearch;

  const filterArgs = {
    kind: url.kind ?? undefined,
    orientation: url.orientation ?? undefined,
    quality: url.quality ?? undefined,
    cameraMake: url.cameraMake ?? undefined,
    storage: url.storage ?? undefined,
    year: url.year ?? undefined,
    tags: url.tags.length > 0 ? url.tags : undefined,
    mentioned: url.mentioned.length > 0 ? url.mentioned : undefined,
    minLikes: url.minLikes ?? undefined,
    watched: url.watched ?? undefined,
    person: url.person ?? undefined,
    sensitive: url.sensitive ?? undefined,
    sort: url.sort ?? undefined,
    shuffleSeed: url.shuffle ?? undefined,
  };

  const facetsQuery = trpc.media.facets.useQuery({
    ...filterArgs,
    query: inSearch ? url.query : undefined,
    similarToUuid: inSimilar ? (url.similar ?? undefined) : undefined,
  }, { enabled: !inPlaylist && !externalMode });

  // Person header data — only fetched when a person is selected; cheap
  // (one row from user.db). The grid query above already filters by
  // `person` via filterArgs.
  const personDetails = trpc.people.get.useQuery(
    { uuid: url.person ?? '', limit: 1, offset: 0 },
    { enabled: !!url.person },
  );

  // Build the "active filters" chip list — surfaces anything that's
  // narrowing the visible items so the user isn't browsing a subset
  // unawares. Skips the loud view-mode axes (query / playlist / similar)
  // since each has its own prominent header.
  const activeFilters: ActiveFilter[] = useMemo(() => {
    const out: ActiveFilter[] = [];
    if (url.kind) {
      out.push({
        key: 'kind',
        label: url.kind === 'photo' ? 'Photos' : 'Videos',
        onRemove: () => url.set({ kind: null }),
      });
    }
    if (url.orientation) {
      out.push({
        key: 'orientation',
        label: url.orientation[0].toUpperCase() + url.orientation.slice(1),
        onRemove: () => url.set({ orientation: null }),
      });
    }
    if (url.quality) {
      const label = url.quality === '4k' ? '4K+' : url.quality.toUpperCase();
      out.push({
        key: 'quality',
        label,
        onRemove: () => url.set({ quality: null }),
      });
    }
    if (url.cameraMake) {
      out.push({
        key: 'camera',
        label: url.cameraMake,
        onRemove: () => url.set({ cameraMake: null }),
      });
    }
    if (url.storage != null) {
      const name = facetsQuery.data?.storages.find((s) => s.value === url.storage)?.name;
      out.push({
        key: 'storage',
        label: name ? `Storage: ${name}` : 'Storage',
        onRemove: () => url.set({ storage: null }),
      });
    }
    if (url.year != null) {
      out.push({
        key: 'year',
        label: String(url.year),
        onRemove: () => url.set({ year: null }),
      });
    }
    for (const t of url.tags) {
      out.push({
        key: `tag-${t}`,
        label: `#${t}`,
        onRemove: () => url.set({ tags: url.tags.filter((x) => x !== t) }),
      });
    }
    for (const t of url.mentioned) {
      out.push({
        key: `mentioned-${t}`,
        label: `“${t}”`,
        onRemove: () => url.set({ mentioned: url.mentioned.filter((x) => x !== t) }),
      });
    }
    if (url.minLikes != null) {
      out.push({
        key: 'likes',
        label: url.minLikes >= 5 ? 'Top picks' : `${url.minLikes}+ likes`,
        onRemove: () => url.set({ minLikes: null }),
      });
    }
    if (url.watched) {
      out.push({
        key: 'watched',
        label: url.watched === 'watched' ? 'Watched only' : 'Unwatched only',
        onRemove: () => url.set({ watched: null }),
      });
    }
    if (url.person) {
      const name = personDetails.data?.person.name;
      out.push({
        key: 'person',
        label: name ? `Person: ${name}` : 'Person',
        onRemove: () => url.set({ person: null }),
      });
    }
    if (url.sensitive === 'hide') {
      out.push({
        key: 'sensitive',
        label: 'Hiding sensitive',
        onRemove: () => url.set({ sensitive: null }),
      });
    } else if (url.sensitive === 'only') {
      out.push({
        key: 'sensitive',
        label: 'Only sensitive',
        onRemove: () => url.set({ sensitive: null }),
      });
    }
    return out;
  }, [
    url, personDetails.data, facetsQuery.data,
  ]);

  const clearAllFilters = () => {
    url.set({
      query: '',
      kind: null,
      orientation: null,
      quality: null,
      cameraMake: null,
      storage: null,
      year: null,
      tags: [],
      mentioned: [],
      minLikes: null,
      watched: null,
      person: null,
      sensitive: null,
    });
  };

  // Infinite-scroll queries — each `pages` entry is one server response; the
  // masonry's onRender loader pulls the next page as the user nears the end.
  // URL state is baked into the query key (via the inputs below), so changing
  // a filter/search resets the query to page 0 automatically.
  const recent = trpc.media.list.useInfiniteQuery(
    { limit: pageSize, ...filterArgs },
    { enabled: inRecent, getNextPageParam: (last) => last.nextCursor, initialCursor: 0 },
  );
  const search = trpc.media.search.useInfiniteQuery(
    { query: url.query, limit: pageSize, ...filterArgs },
    { enabled: inSearch, getNextPageParam: (last) => last.nextCursor, initialCursor: 0 },
  );
  const similar = trpc.media.similar.useInfiniteQuery(
    { uuid: url.similar ?? '', limit: pageSize, ...filterArgs },
    { enabled: inSimilar, getNextPageParam: (last) => last.nextCursor, initialCursor: 0 },
  );
  const playlist = trpc.playlist.get.useInfiniteQuery(
    { uuid: url.playlist ?? '', limit: pageSize },
    { enabled: inPlaylist, getNextPageParam: (last) => last.nextCursor, initialCursor: 0 },
  );

  // The active query for this view drives loading + infinite-load wiring.
  const active = inPlaylist ? playlist : inSimilar ? similar : inSearch ? search : recent;
  const loading = active.isLoading;
  const hasMore = active.hasNextPage ?? false;
  const loadMore = () => { void active.fetchNextPage(); };

  const items: MediaItemDto[] = useMemo(() => {
    if (inPlaylist) {
      return playlist.data?.pages.flatMap((p) =>
        p.items
          .filter((it) => it.available)
          .map((it) => (it as unknown as { available: true; item: MediaItemDto }).item),
      ) ?? [];
    }
    if (inSimilar) return similar.data?.pages.flatMap((p) => p.items) ?? [];
    if (inSearch) return search.data?.pages.flatMap((p) => p.items) ?? [];
    return recent.data?.pages.flatMap((p) => p.items) ?? [];
  }, [inPlaylist, inSimilar, inSearch, playlist.data, similar.data, search.data, recent.data]);

  // Per-view metadata for the headers (first page carries it).
  const similarSource = similar.data?.pages[0]?.source ?? null;
  const playlistMeta = playlist.data?.pages[0]?.playlist ?? null;
  const playlistTotal = playlist.data?.pages[0]?.totalCount;
  const totalCount = inPlaylist
    ? playlistTotal
    : inRecent
      ? recent.data?.pages[0]?.totalCount
      : undefined; // search/similar are top-K ranked — no meaningful total

  // Dataset identity — when it changes, the grid remounts (fresh masonry
  // positions) and we scroll back to the top.
  const resetKey = JSON.stringify([
    inPlaylist ? `pl:${url.playlist}` : inSimilar ? `sim:${url.similar}` : inSearch ? `q:${url.query}` : 'recent',
    filterArgs, pageSize,
  ]);
  useEffect(() => {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
    setLastViewed(null); // the resume point belongs to the previous result set
  }, [resetKey]);

  // The viewer walks the single accumulated `items` list — no page boundaries
  // to cross anymore. Just find the selected item by uuid.
  const selectedIndex = selectedUuid ? items.findIndex((i) => i.uuid === selectedUuid) : -1;
  const selected: MediaItemDto | null = selectedIndex >= 0 ? items[selectedIndex] : null;

  // "Next" at the end of the loaded list (with more available) fetches the next
  // page and then advances once it arrives. This ref carries that intent across
  // the fetch.
  const advanceAfterLoadRef = useRef(false);
  useEffect(() => {
    if (!advanceAfterLoadRef.current) return;
    if (selectedIndex >= 0 && selectedIndex < items.length - 1) {
      advanceAfterLoadRef.current = false;
      setSelectedUuid(items[selectedIndex + 1].uuid);
    }
  }, [items.length, selectedIndex, setSelectedUuid]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleOpen = (item: MediaItemDto, match?: { tStartMs: number | null }) => {
    // Open straight to fullscreen (view:'full') — there's no intermediate
    // preview modal anymore. A search-hit with a timestamp also seeks; a normal
    // open clears any stale `t` so it doesn't inherit a previous deep-link seek.
    url.set({ item: item.uuid, view: 'full', tMs: match?.tStartMs != null ? match.tStartMs : null });
  };
  const handleClose = () => {
    // Clearing `view` drops both fullscreen AND slideshow (slideshow is
    // derived from view==='slideshow'). Also clear any deep-link seek.
    url.set({ item: null, view: null, tMs: null });
  };

  const startSlideshow = () => {
    if (items.length === 0) return;
    // Open the item AND enter slideshow in one url.set so they propagate
    // together (view='slideshow' implies fullscreen). Single write avoids an
    // intermediate render where the viewer is unmounted.
    //
    // Guard against a STALE url.item: now that view+item persist in the URL,
    // a reload can leave ?item=X where X isn't in the current visible set
    // (different filter/page). selectedUuid would then be that stale X, and
    // re-setting it produces the same URL → router.replace no-ops → nothing
    // opens. So only honor selectedUuid if it's actually visible; otherwise
    // start from the first item.
    const targetUuid =
      selectedUuid && items.some((i) => i.uuid === selectedUuid)
        ? selectedUuid
        : items[0].uuid;
    url.set({ item: targetUuid, view: 'slideshow' });
  };

  const handleToggleSelection = (item: MediaItemDto, e: React.MouseEvent) => {
    const targetRef: SelectionRef = { librarySlug: item.librarySlug, itemUuid: item.uuid };
    const targetKey = selectionKey(item.librarySlug, item.uuid);

    if (e.shiftKey && anchor) {
      const anchorIdx = items.findIndex(
        (i) => i.librarySlug === anchor.librarySlug && i.uuid === anchor.itemUuid,
      );
      const targetIdx = items.findIndex(
        (i) => i.librarySlug === item.librarySlug && i.uuid === item.uuid,
      );
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const [from, to] = anchorIdx <= targetIdx
          ? [anchorIdx, targetIdx]
          : [targetIdx, anchorIdx];
        const rangeRefs: SelectionRef[] = items
          .slice(from, to + 1)
          .map((i) => ({ librarySlug: i.librarySlug, itemUuid: i.uuid }));
        const existing = new Set(
          selection.map((s) => selectionKey(s.librarySlug, s.itemUuid)),
        );
        const additions = rangeRefs.filter(
          (r) => !existing.has(selectionKey(r.librarySlug, r.itemUuid)),
        );
        if (additions.length > 0) setSelection([...selection, ...additions]);
        return;
      }
    }

    if (selectedKeys.has(targetKey)) {
      setSelection(selection.filter((s) => selectionKey(s.librarySlug, s.itemUuid) !== targetKey));
    } else {
      setSelection([...selection, targetRef]);
    }
    setAnchor(targetRef);
  };

  const clearSelection = () => {
    setSelection([]);
    setAnchor(null);
  };

  // "Selecting" is active once anything is selected (via the hover checkbox /
  // ⌘-click / shift-click). In that state a plain click on a thumbnail toggles
  // its selection instead of opening the preview. There's no separate "arm
  // selection mode" toggle — you start selecting by selecting an item.
  const selecting = selection.length > 0;

  // Navigation over the single accumulated list. "Next" past the last loaded
  // item fetches more and advances when it arrives (advanceAfterLoadRef);
  // slideshow wraps to the top once everything's loaded.
  const onPrev = selectedIndex > 0
    ? () => setSelectedUuid(items[selectedIndex - 1].uuid)
    : undefined;

  const atVeryEnd = selectedIndex >= 0 && selectedIndex >= items.length - 1 && !hasMore;
  const onNext = selectedIndex >= 0 && selectedIndex < items.length - 1
    ? () => setSelectedUuid(items[selectedIndex + 1].uuid)
    : hasMore
      ? () => { advanceAfterLoadRef.current = true; loadMore(); }
      : slideshow && atVeryEnd && items.length > 0
        ? () => setSelectedUuid(items[0].uuid)
        : undefined;

  const onSeeSimilar = (item: MediaItemDto) => {
    url.set({
      similar: item.uuid, query: '', playlist: null, person: null, source: null, category: null,
      item: null, view: null,
    });
  };

  const clearSimilar = () => url.set({ similar: null });

  const handleSearchSubmit = (q: string) => {
    url.set({ query: q, similar: q ? null : undefined, playlist: q ? null : undefined, source: q ? null : undefined, category: q ? null : undefined });
  };

  const handlePlaylistSelect = (uuid: string | null) => {
    // view:null clears slideshow (it's derived from view) along with the viewer.
    url.set({
      playlist: uuid, similar: null, query: '', person: null, source: null, category: null,
      item: null, view: null,
    });
    setSelection([]);
  };

  const handlePersonSelect = (uuid: string | null) => {
    url.set({
      person: uuid, playlist: null, similar: null, source: null, category: null,
      item: null, view: null,
    });
    setSelection([]);
  };

  // Select an external source (or null to return to the internal library).
  // Clears every internal view axis (and the category) so realms never blend.
  const handleSelectSource = (slug: string | null) => {
    url.set({
      source: slug, category: null, playlist: null, similar: null, query: '', person: null,
      item: null, view: null,
    });
    setSelection([]);
  };

  // Select an external-source CATEGORY (a group of live channels) — or null to
  // return to the library. Clears the single-source + every internal view axis.
  const handleSelectCategory = (category: string | null) => {
    url.set({
      category, source: null, playlist: null, similar: null, query: '', person: null,
      item: null, view: null,
    });
    setSelection([]);
  };

  // Person rename mutation. Invalidates the people list (sidebar) and the
  // currently-open person details so the new name shows up immediately.
  const renamePerson = trpc.people.rename.useMutation({
    onSuccess: () => {
      trpcUtils.people.list.invalidate();
      trpcUtils.people.get.invalidate();
    },
  });
  const [editingPersonName, setEditingPersonName] = useState(false);
  const [draftPersonName, setDraftPersonName] = useState('');
  // Items targeted for face reassignment. Single item from the viewer or
  // many from the SelectionBar — same dialog handles both. Null = closed.
  const [reassignItems, setReassignItems] = useState<MediaItemDto[] | null>(null);
  // The set of items targeted by the move dialog — either the multi-selection
  // (from the SelectionBar) or a single item (from the viewer kebab).
  const [moveSelection, setMoveSelection] = useState<SelectionRef[] | null>(null);
  // Item targeted for the "Add to playlist" dialog. Single-item only —
  // multi-add still flows through the SelectionBar's dropdown.
  const [addToPlaylistItem, setAddToPlaylistItem] = useState<MediaItemDto | null>(null);
  // Item pending the "exclude" (soft-delete) confirmation.
  const [excludeItem, setExcludeItem] = useState<MediaItemDto | null>(null);

  // Like-count cache patch. Used by BOTH the local setLike mutation's
  // onSuccess AND the cross-session 'item.like' sync event, so a like
  // performed in another tab/device updates this session's cache without
  // a refetch (refetching would yank a now-viewed item out of an
  // unwatched-filtered list — see the matching comment in setLike below).
  const trpcUtils = trpc.useUtils();
  const queryClient = useQueryClient();
  const applyLikePatch = useCallback((uuid: string, count: number) => {
    const patchFlat = (old: unknown) => patchInfinitePages(old, (it) =>
      it.uuid === uuid ? { ...it, likeCount: count } : null);
    const patchPlaylist = (old: unknown) => patchInfinitePages(old, (it) => {
      const w = it as { available?: boolean; item?: { uuid?: string } & Record<string, unknown> };
      return w.available && w.item?.uuid === uuid ? { ...w, item: { ...w.item, likeCount: count } } : null;
    });
    queryClient.setQueriesData({ queryKey: [['media', 'list']] }, patchFlat);
    queryClient.setQueriesData({ queryKey: [['media', 'search']] }, patchFlat);
    queryClient.setQueriesData({ queryKey: [['media', 'similar']] }, patchFlat);
    queryClient.setQueriesData({ queryKey: [['playlist', 'get']] }, patchPlaylist);
  }, [queryClient]);

  const setLikeMutation = trpc.media.setLike.useMutation({
    onSuccess: (_data, vars) => {
      applyLikePatch(vars.uuid, vars.count);
      trpcUtils.media.facets.invalidate();
      trpcUtils.media.getDetails.invalidate();
    },
  });

  // ── Rotation: same cache-patch pattern as likes, so the rotate-button
  // is instant and the viewer doesn't get yanked closed by a refetch.
  const applyRotationPatch = useCallback((uuid: string, rotation: number) => {
    const patchFlat = (old: unknown) => patchInfinitePages(old, (it) =>
      it.uuid === uuid ? { ...it, rotation } : null);
    const patchPlaylist = (old: unknown) => patchInfinitePages(old, (it) => {
      const w = it as { available?: boolean; item?: { uuid?: string } & Record<string, unknown> };
      return w.available && w.item?.uuid === uuid ? { ...w, item: { ...w.item, rotation } } : null;
    });
    queryClient.setQueriesData({ queryKey: [['media', 'list']] }, patchFlat);
    queryClient.setQueriesData({ queryKey: [['media', 'search']] }, patchFlat);
    queryClient.setQueriesData({ queryKey: [['media', 'similar']] }, patchFlat);
    queryClient.setQueriesData({ queryKey: [['playlist', 'get']] }, patchPlaylist);
  }, [queryClient]);

  const setRotationMutation = trpc.media.setRotation.useMutation({
    onSuccess: (_data, vars) => {
      applyRotationPatch(vars.uuid, vars.rotation);
    },
  });

  const excludeMutation = trpc.media.exclude.useMutation({
    onSuccess: () => {
      // Item now soft-deleted — refetch the lists/facets so it drops out.
      trpcUtils.media.list.invalidate();
      trpcUtils.media.search.invalidate();
      trpcUtils.media.similar.invalidate();
      trpcUtils.media.facets.invalidate();
      trpcUtils.playlist.get.invalidate();
    },
  });

  const setSensitiveMutation = trpc.media.setSensitive.useMutation({
    onSuccess: () => {
      // An override can move an item in/out of a sensitivity-filtered view and
      // flips the badge — refetch lists/facets + the open item's details.
      trpcUtils.media.list.invalidate();
      trpcUtils.media.search.invalidate();
      trpcUtils.media.similar.invalidate();
      trpcUtils.media.facets.invalidate();
      trpcUtils.media.getDetails.invalidate();
    },
  });

  const handleRotate = (item: MediaItemDto, nextRotation: 0 | 90 | 180 | 270) => {
    // Optimistic patch first — instant UI feedback. The server mutation
    // confirms and the sync event echoes to other tabs/devices.
    applyRotationPatch(item.uuid, nextRotation);
    setRotationMutation.mutate({
      uuid: item.uuid,
      rotation: nextRotation,
      librarySlug: item.librarySlug,
    });
  };

  const handleSetLikes = async (item: MediaItemDto, count: number) => {
    await setLikeMutation.mutateAsync({
      uuid: item.uuid,
      count,
      librarySlug: item.librarySlug,
    });
  };

  // Tailwind class fragment applied to top-level page chrome so they all
  // breathe with the same fade when quiet mode flips on/off.
  const chromeQuietClass = quietMode
    ? 'opacity-30 pointer-events-none transition-opacity duration-500'
    : 'opacity-100 transition-opacity duration-500';

  return (
    <main className="min-h-screen">
      {/* kn-app-scaled (large-screen zoom) lives on the header + sidebars only —
          NOT the grid/content column, since CSS zoom desyncs masonic's
          virtualization math. The grid scales via responsive columnWidth. */}
      <header className={`kn-app-scaled sticky top-0 z-30 bg-zinc-950/80 backdrop-blur border-b border-zinc-900 ${chromeQuietClass}`}>
        <div className="px-5 py-4 flex items-center gap-4">
          <button
            onClick={toggleSidebar}
            aria-pressed={sidebarOpen}
            title={sidebarOpen ? 'Hide filters' : 'Show filters'}
            aria-label="Toggle filters sidebar"
            className="hidden md:flex items-center justify-center text-zinc-400 hover:text-zinc-100
                       hover:bg-zinc-800 rounded px-2 py-1.5 transition shrink-0"
          >
            <SidebarToggleIcon />
          </button>
          <div className="flex-1">
            <SearchBar initial={url.query} onSubmit={handleSearchSubmit} />
          </div>
        </div>
      </header>

      <div className="px-4 py-5 flex">
        {/* Collapse by ANIMATING width (not display:none) so the grid is pushed
            smoothly instead of snapping. The inner wrapper stays a fixed w-56 so
            its content clips/slides rather than reflowing while the outer shrinks.
            Quiet-mode fade lives on the inner div so its opacity transition
            doesn't collide with the width transition here. */}
        <aside
          className={`kn-app-scaled shrink-0 sticky top-20 self-start overflow-x-hidden overflow-y-auto
                     max-h-[calc((100vh-6rem)/var(--kn-chrome-scale,1))] ${slideClass}
                     ${sidebarOpen ? 'w-56 mr-6' : 'w-0 mr-0'}`}
        >
          <div className="kn-sidebar-body" data-open={sidebarOpen}>
          {/* Two-pane horizontal track: the main sidebar and the sources
              manager sit side by side; opening the manager slides the track
              left so it "comes out of" the sidebar (the aside's overflow-x-hidden
              clips the off-screen pane). No backdrop — Back returns. */}
          <div className={`w-56 ${chromeQuietClass}`}>
          <div className={`flex w-[200%] items-start
                          ${sidebarAnimate ? 'transition-transform duration-300 ease-in-out' : ''}
                          ${sourcesOpen ? '-translate-x-1/2' : ''}`}>
          <div className="w-1/2 shrink-0 pr-2">
          <h1 className="px-3 mb-5">
            <KenNookLogo height={24} />
            <span className="sr-only">KenNook</span>
          </h1>
          {/* Library selection — hidden when there's only one library. */}
          <div className="px-1 mb-5">
            <LibrarySwitcher variant="sidebar" align="left" hideWhenSingle />
          </div>
          <PlaylistsSection
            activePlaylistUuid={url.playlist}
            onSelectPlaylist={handlePlaylistSelect}
          />
          <SourcesSection
            activeSourceSlug={url.source}
            activeCategory={url.category}
            onOpenManager={() => setSourcesOpen(true)}
          />
          <SavedSearchesSection />
          <PeopleSection
            activePersonUuid={url.person}
            onSelectPerson={handlePersonSelect}
          />
          {!inPlaylist && (
            <FilterSidebar
              facets={facetsQuery.data ?? null}
              loading={facetsQuery.isLoading}
              kind={url.kind}
              onKindChange={(v) => url.set({ kind: v })}
              orientation={url.orientation}
              onOrientationChange={(v) => url.set({ orientation: v })}
              quality={url.quality}
              onQualityChange={(v) => url.set({ quality: v })}
              cameraMake={url.cameraMake}
              onCameraChange={(v) => url.set({ cameraMake: v })}
              storage={url.storage}
              onStorageChange={(v) => url.set({ storage: v })}
              year={url.year}
              onYearChange={(v) => url.set({ year: v })}
              tags={url.tags}
              onTagsChange={(v) => url.set({ tags: v })}
              mentioned={url.mentioned}
              onMentionedChange={(v) => url.set({ mentioned: v })}
              minLikes={url.minLikes}
              onMinLikesChange={(v) => url.set({ minLikes: v })}
              watched={url.watched}
              onWatchedChange={(v) => url.set({ watched: v })}
              sensitive={url.sensitive}
              onSensitiveChange={(v) => url.set({ sensitive: v })}
            />
          )}
          <SidebarTools onOpenHelp={() => setHelpOpen(true)} />
          </div>
          <div className="w-1/2 shrink-0 pr-2">
            <SourcesManager
              activeSourceSlug={url.source}
              activeCategory={url.category}
              onSelectSource={handleSelectSource}
              onSelectCategory={handleSelectCategory}
              onBack={() => setSourcesOpen(false)}
            />
          </div>
          </div>
          </div>
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          {inCategory ? (
            <ExternalSourceView category={url.category!} suspended={screensaverOpen} />
          ) : inExternal ? (
            <ExternalSourceView slug={url.source!} suspended={screensaverOpen} />
          ) : (
          <>
          <SelectionBar
            selection={selection}
            onClear={clearSelection}
            currentPlaylistUuid={inPlaylist ? url.playlist : null}
            currentPlaylistName={inPlaylist ? playlistMeta?.name ?? null : null}
            onRemovedFromPlaylist={clearSelection}
            currentPersonUuid={url.person}
            onReassignSelection={() => {
              // Resolve the selection (which is librarySlug + uuid only) to
              // full MediaItemDtos from the currently visible items[]. Items
              // not in items[] (selected on a different page before
              // navigation) are dropped — they'll need to be reselected.
              const refs = selection
                .map((s) => items.find((it) =>
                  it.librarySlug === s.librarySlug && it.uuid === s.itemUuid,
                ))
                .filter((it): it is MediaItemDto => !!it);
              if (refs.length === 0) return;
              setReassignItems(refs);
            }}
            onMoveSelection={() => setMoveSelection(selection)}
          />

          {url.person && personDetails.data && (
            <div className="mb-4 flex items-center gap-3 bg-zinc-900/60 border border-zinc-800
                            rounded-lg px-3 py-2">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-zinc-800 shrink-0">
                {personDetails.data.person.coverThumbnailUrl && (
                  <img
                    src={personDetails.data.person.coverThumbnailUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 uppercase tracking-wider">Person</div>
                {editingPersonName ? (
                  <input
                    autoFocus
                    value={draftPersonName}
                    onChange={(e) => setDraftPersonName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        // Commit + close — onBlur won't fire if input unmounts first.
                        const name = draftPersonName.trim();
                        if (url.person) {
                          renamePerson.mutate({
                            uuid: url.person,
                            name: name.length > 0 ? name : null,
                          });
                        }
                        setEditingPersonName(false);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingPersonName(false);
                      }
                    }}
                    onBlur={() => {
                      if (!editingPersonName) return;
                      const name = draftPersonName.trim();
                      if (url.person) {
                        renamePerson.mutate({
                          uuid: url.person,
                          name: name.length > 0 ? name : null,
                        });
                      }
                      setEditingPersonName(false);
                    }}
                    placeholder="Name this person…"
                    maxLength={120}
                    className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1
                               text-base text-zinc-100 focus:border-zinc-500 outline-none
                               w-full"
                  />
                ) : (
                  <button
                    onClick={() => {
                      setDraftPersonName(personDetails.data?.person.name ?? '');
                      setEditingPersonName(true);
                    }}
                    className="text-lg font-medium text-zinc-100 hover:text-zinc-300
                               text-left truncate w-full flex items-center gap-2 group"
                    title="Click to rename"
                  >
                    <span className="truncate">
                      {personDetails.data.person.name ?? (
                        <span className="text-zinc-500 italic">Unnamed person</span>
                      )}
                    </span>
                    <PencilIcon />
                  </button>
                )}
                <div className="text-sm text-zinc-500">
                  {personDetails.data.totalCount} photo{personDetails.data.totalCount === 1 ? '' : 's'}
                </div>
              </div>
              {personDetails.data.totalCount > 0 && (
                <PlayButton onClick={startSlideshow} />
              )}
              <button
                onClick={() => handlePersonSelect(null)}
                className="text-zinc-400 hover:text-zinc-100 px-2"
                aria-label="Clear person"
              >
                ×
              </button>
            </div>
          )}

          {inSimilar && similarSource && (
            <div className="mb-4 flex items-center gap-3 bg-zinc-900/60 border border-zinc-800
                            rounded-lg px-3 py-2">
              <img
                src={similarSource.thumbnailUrl}
                alt={similarSource.filename}
                className="w-10 h-10 object-cover rounded shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500">Similar to</div>
                <div className="text-sm text-zinc-200 truncate">
                  {similarSource.filename}
                </div>
              </div>
              {items.length > 0 && <PlayButton onClick={startSlideshow} />}
              <button
                onClick={clearSimilar}
                className="text-zinc-400 hover:text-zinc-100 px-2"
                aria-label="Clear similar"
              >
                ×
              </button>
            </div>
          )}

          {inPlaylist && playlistMeta && (
            <div className="mb-4 flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 uppercase tracking-wider">Playlist</div>
                <div className="text-lg text-zinc-100 font-medium">{playlistMeta.name}</div>
                <div className="text-sm text-zinc-500">
                  {playlistTotal} item{playlistTotal === 1 ? '' : 's'}
                </div>
              </div>
              {(playlistTotal ?? 0) > 0 && (
                <div className="shrink-0 mt-1">
                  <PlayButton onClick={startSlideshow} />
                </div>
              )}
            </div>
          )}

          {inSearch && (
            <div className="mb-4 flex items-center gap-4">
              <div className="text-sm text-zinc-500 flex-1">
                Results for{' '}
                <span className="text-zinc-300">&ldquo;{url.query}&rdquo;</span>
              </div>
              {items.length > 0 && <PlayButton onClick={startSlideshow} />}
            </div>
          )}

          {inSimilar && !similarSource && (
            <div className="text-sm text-zinc-500 mb-4">Loading…</div>
          )}

          {inRecent && (
            <div className="mb-4 flex items-center gap-4">
              <div className="text-sm text-zinc-500 flex-1">
                Recently captured
                <span className="ml-2 text-xs text-zinc-600">
                  · ⌘-click or Shift-click to select
                </span>
              </div>
              {items.length > 0 && <PlayButton onClick={startSlideshow} />}
            </div>
          )}

          <FilterStatusBar
            filters={activeFilters}
            onClearAll={clearAllFilters}
          />

          {/* View controls: results-per-page (always) + sort/shuffle (browse and
              search/similar; playlists keep their own order). Picking a sort
              clears shuffle; the shuffle toggle mints a fresh seed on / clears
              it off. */}
          <div className="flex items-center justify-end gap-3 mb-3">
            <PageSizeControl value={pageSize} onChange={changePageSize} />
            {!inPlaylist && (
              <SortControl
                sort={url.sort}
                shuffle={url.shuffle}
                relevanceMode={inSearch || inSimilar}
                onSelectSort={(key) => url.set({ sort: key, shuffle: null })}
                onToggleShuffle={() =>
                  url.set({ shuffle: url.shuffle != null ? null : Math.floor(Math.random() * 2_000_000_000) })
                }
              />
            )}
          </div>

          <MediaGrid
            items={items}
            onSelect={handleOpen}
            onToggleSelection={handleToggleSelection}
            selectedKeys={selectedKeys}
            selectionMode={selecting}
            onSetLikes={handleSetLikes}
            loading={loading}
            onLoadMore={loadMore}
            hasMore={hasMore}
            resetKey={resetKey}
            highlightUuid={url.item ? null : lastViewed?.uuid ?? null}
            scrollSignal={scrollSignal}
          />

          {/* Infinite-scroll status footer (replaces the pager). */}
          {items.length > 0 && (
            <div className="py-6 text-center text-xs text-zinc-600">
              {active.isFetchingNextPage
                ? 'Loading more…'
                : !hasMore
                  ? (totalCount != null
                      ? `${items.length.toLocaleString()} of ${totalCount.toLocaleString()} · end`
                      : `${items.length.toLocaleString()} items`)
                  : null}
            </div>
          )}

          {/* Resume pill — reopen the last-viewed item (photo/video/slideshow)
              without hunting for it in the grid. */}
          {!url.item && lastViewed && (() => {
            const it = items.find((i) => i.uuid === lastViewed.uuid);
            return (
              <div className="kn-app-scaled fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3
                              bg-zinc-900/95 backdrop-blur ring-1 ring-zinc-700 rounded-full pl-4 pr-2 py-2 shadow-2xl">
                <button
                  onClick={() => url.set({ item: lastViewed.uuid, view: lastViewed.view, tMs: null })}
                  className="flex items-center gap-2 text-sm text-zinc-100"
                >
                  <span className="grid place-items-center w-6 h-6 rounded-full bg-sky-400 text-zinc-900">
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z" /></svg>
                  </span>
                  <span className="max-w-[16rem] truncate">
                    {lastViewed.view === 'slideshow' ? 'Resume slideshow' : 'Resume'}
                    {it ? `: ${it.filename}` : ''}
                  </span>
                </button>
                <button onClick={() => setLastViewed(null)} title="Dismiss"
                  className="text-zinc-500 hover:text-zinc-200 px-1.5">×</button>
              </div>
            );
          })()}
          </>
          )}
        </div>
      </div>

      <MediaViewer
        item={selected}
        maxed={viewerMaxed}
        onMaxedChange={setViewerMaxed}
        onClose={handleClose}
        onPrev={onPrev}
        onNext={onNext}
        onSeeSimilar={onSeeSimilar}
        onSetLikes={handleSetLikes}
        position={selected ? { index: selectedIndex, total: items.length } : undefined}
        slideshow={slideshow}
        // Toggle slideshow (auto-advance) from within fullscreen.
        onSlideshowExit={() => url.set({ view: 'full' })}
        onSlideshowEnter={() => url.set({ view: 'slideshow' })}
        currentPersonUuid={url.person}
        onReassignPerson={(it) => setReassignItems([it])}
        onRotate={handleRotate}
        reelItems={items}
        reelHasMore={hasMore}
        onSelectItem={(it) => setSelectedUuid(it.uuid)}
        onAddToPlaylist={(it) => setAddToPlaylistItem(it)}
        onExclude={(it) => setExcludeItem(it)}
        onMove={(it) => setMoveSelection([{ librarySlug: it.librarySlug, itemUuid: it.uuid }])}
        onSetSensitive={(it, override) =>
          setSensitiveMutation.mutate({ uuid: it.uuid, override, librarySlug: it.librarySlug })
        }
        quiet={quietMode}
        suspended={screensaverOpen}
        initialTimeMs={url.tMs}
      />

      {addToPlaylistItem && (
        <AddToPlaylistDialog
          item={addToPlaylistItem}
          onClose={() => setAddToPlaylistItem(null)}
        />
      )}

      {excludeItem && (
        <ConfirmDialog
          title="Exclude this item?"
          message="It'll be hidden from all results — browse, search, playlists, everywhere. The file isn't deleted from disk, so this is recoverable."
          confirmLabel="Exclude"
          danger
          onCancel={() => setExcludeItem(null)}
          onConfirm={() => {
            const target = excludeItem;
            // If it's the item open in the viewer, advance to a neighbor first
            // (or close if it was the last) so we don't strand on a vanished item.
            if (selected && selected.uuid === target.uuid) {
              const nextUuid = items[selectedIndex + 1]?.uuid ?? items[selectedIndex - 1]?.uuid ?? null;
              setSelectedUuid(nextUuid);
            }
            excludeMutation.mutate({ uuid: target.uuid, librarySlug: target.librarySlug });
            setExcludeItem(null);
          }}
        />
      )}

      {reassignItems && url.person && (
        <ReassignPersonDialog
          items={reassignItems}
          fromPersonUuid={url.person}
          onClose={() => setReassignItems(null)}
          onReassigned={() => {
            const wasBatch = reassignItems.length > 1;
            setReassignItems(null);
            if (wasBatch) {
              // Clear selection + refresh the person-filtered grid so the
              // reassigned items disappear. The dialog already invalidated
              // people.list/get; this rounds out the visual state.
              clearSelection();
              trpcUtils.media.list.invalidate();
              trpcUtils.media.search.invalidate();
              trpcUtils.media.similar.invalidate();
            } else if (onNext) {
              // Single-item case (from viewer): auto-advance. We deliberately
              // don't refetch the underlying list — that would close the
              // viewer; the list refreshes on next nav.
              onNext();
            }
          }}
        />
      )}

      {moveSelection && (
        <MoveToLibraryDialog
          selection={moveSelection}
          onClose={() => setMoveSelection(null)}
          onMoved={() => {
            // If the open viewer item was moved, advance to a neighbor (or close)
            // so we don't strand on a vanished item.
            const movedUuids = new Set(moveSelection.map((s) => s.itemUuid));
            if (selected && movedUuids.has(selected.uuid)) {
              const nextUuid =
                items[selectedIndex + 1]?.uuid ?? items[selectedIndex - 1]?.uuid ?? null;
              setSelectedUuid(nextUuid);
            }
            // Refetch our own lists/facets so the moved items drop out now. The
            // 'items.moved' sync event covers OTHER tabs but skips this (the
            // originating) session, so the active tab must invalidate locally —
            // same as excludeMutation.onSuccess.
            trpcUtils.media.list.invalidate();
            trpcUtils.media.search.invalidate();
            trpcUtils.media.similar.invalidate();
            trpcUtils.media.facets.invalidate();
            trpcUtils.playlist.get.invalidate();
            setMoveSelection(null);
            clearSelection();
          }}
        />
      )}

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      <Screensaver
        open={screensaverOpen}
        onExit={dismissScreensaver}
      />
    </main>
  );
}

function SidebarToggleIcon() {
  // Panel-with-left-rail glyph — reads as "show/hide the side panel".
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor">
      <path d="M3 2 L10 6 L3 10 Z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="11" height="11" viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
      className="text-zinc-500 group-hover:text-zinc-300 transition shrink-0"
    >
      <path d="M11 2l3 3L5.5 13.5 2 14l.5-3.5L11 2z" />
    </svg>
  );
}

function PageSizeControl({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-zinc-500 shrink-0">
      <span>Per page</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Results per page"
        className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-300
                   hover:border-zinc-700 focus:border-zinc-600 outline-none cursor-pointer"
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}

function PlayButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Play slideshow"
      className="shrink-0 inline-flex items-center gap-2 rounded-md
                 bg-emerald-400 hover:bg-emerald-300 text-zinc-900
                 font-medium text-sm px-3 py-1.5 transition"
    >
      <PlayIcon />
      Play
    </button>
  );
}
