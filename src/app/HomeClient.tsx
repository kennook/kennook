'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
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
import { LibrarySwitcher } from '@/components/LibrarySwitcher';
import { KenNookLogo } from '@/components/KenNookLogo';
import { AdminLinkButton } from '@/components/admin/AdminLinkButton';
import { ShortcutHelp } from '@/components/ShortcutHelp';
import { useIsMobile } from '@/lib/use-media-query';
import { FilterSidebar } from '@/components/FilterSidebar';
import { PlaylistsSection } from '@/components/PlaylistsSection';
import { SavedSearchesSection } from '@/components/SavedSearchesSection';
import { PeopleSection } from '@/components/PeopleSection';
import { SelectionBar } from '@/components/SelectionBar';
import { Pagination } from '@/components/Pagination';
import { useShortcut } from '@/lib/shortcuts';
import { useSync, useSyncEvent } from '@/lib/sync';

interface SelectionRef {
  librarySlug: string;
  itemUuid: string;
}

const PAGE_SIZE = 60;

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

  // Fullscreen + slideshow BOTH live in the URL via ?view= (tri-state:
  // 'full' | 'slideshow' | null). Keeping slideshow in the URL — not React
  // state — means it survives anything that overlays the page (the
  // screensaver) and hard refreshes: dismissing the screensaver restores the
  // exact view the URL describes. Slideshow implies fullscreen.
  const viewerMaxed = url.view === 'full' || url.view === 'slideshow';
  const slideshow = url.view === 'slideshow';
  const setViewerMaxed = useCallback((m: boolean) => {
    // Un-maximizing always exits to the modal viewer (clears slideshow too).
    // Maximizing from the modal enters plain fullscreen, not slideshow.
    url.set({ view: m ? 'full' : null });
  }, [url]);

  // Transient (non-URL) state.
  const [helpOpen, setHelpOpen] = useState(false);
  const [selection, setSelection] = useState<SelectionRef[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [anchor, setAnchor] = useState<SelectionRef | null>(null);
  // Walk-away screensaver. Triggered by `S` shortcut, exits on any input.
  const [screensaverOpen, setScreensaverOpen] = useState(false);
  // Post-screensaver "quiet" state: when true, page chrome (header, sidebar,
  // viewer chrome) fades to a low-opacity, non-interactive state. Cleared on
  // the first real user input (mouse move / key / wheel / touch).
  const [quietMode, setQuietMode] = useState(false);
  // When prev/next steps across a page boundary, we update the URL's `page`
  // param and remember which end of the next page to land on. The viewer
  // uses this as a fallback selection while React Query is fetching, so the
  // user sees a seamless transition (no flash of empty viewer).
  const [postLoadIntent, setPostLoadIntent] = useState<'first' | 'last' | null>(null);

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

  // Timestamp of the last LOCAL screensaver toggle. The cross-process poll
  // below trusts local intent for a short window after a toggle so a stale
  // in-flight poll can't briefly re-open/close the screensaver under us.
  const lastLocalScreensaverChangeRef = useRef(0);

  const triggerScreensaver = () => {
    lastLocalScreensaverChangeRef.current = Date.now();
    setScreensaverOpen(true);
    sync.publish({ type: 'screensaver', open: true });
  };
  const dismissScreensaver = () => {
    lastLocalScreensaverChangeRef.current = Date.now();
    setScreensaverOpen(false);
    setQuietMode(true);
    sync.publish({ type: 'screensaver', open: false });
  };

  useShortcut('global.screensaver', triggerScreensaver);

  // Instant path: same-process devices get the toggle live via SSE.
  useSyncEvent('screensaver', (e) => {
    lastLocalScreensaverChangeRef.current = Date.now();
    setScreensaverOpen(e.open);
  });

  // Cross-process path: caddy fronts a prod build (:3001) AND the dev server
  // (:3000), so devices on different origins land on different Node processes
  // whose in-memory SSE brokers don't talk to each other. They DO share one
  // user.db, so poll the persisted state to converge. The guard window keeps
  // a stale poll from clobbering a just-made local change.
  useEffect(() => {
    let alive = true;
    const SCREENSAVER_POLL_MS = 2000;
    const GUARD_MS = 3000;
    const poll = async () => {
      try {
        const res = await fetch('/api/sync/state', { cache: 'no-store' });
        if (!res.ok || !alive) return;
        const data = await res.json() as { screensaver?: boolean };
        if (typeof data.screensaver !== 'boolean') return;
        if (Date.now() - lastLocalScreensaverChangeRef.current < GUARD_MS) return;
        setScreensaverOpen((cur) => (cur === data.screensaver ? cur : data.screensaver!));
      } catch { /* offline / transient — try again next tick */ }
    };
    const t = setInterval(poll, SCREENSAVER_POLL_MS);
    void poll();
    return () => { alive = false; clearInterval(t); };
  }, []);

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

  // Quietly warm the browser cache with the screensaver video during idle
  // time so the first trigger plays instantly. ~1.4MB for 1080p.
  useEffect(() => preloadScreensaverInBackground(), []);

  // View modes derived from URL — playlist > similar > search > recent.
  const inPlaylist = !!url.playlist;
  const inSimilar = !inPlaylist && !!url.similar;
  const inSearch = !inPlaylist && !inSimilar && url.query !== '';
  const inRecent = !inPlaylist && !inSimilar && !inSearch;

  const offset = (url.page - 1) * PAGE_SIZE;

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
  }, { enabled: !inPlaylist });

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

  // `placeholderData: keepPreviousData` keeps the prior page's items visible
  // during the next-page fetch — critical for the in-viewer cross-page
  // transition to feel instant rather than flashing through an empty state.
  const recent = trpc.media.list.useQuery(
    { limit: PAGE_SIZE, offset, ...filterArgs },
    { enabled: inRecent, placeholderData: keepPreviousData },
  );
  const search = trpc.media.search.useQuery(
    { query: url.query, limit: PAGE_SIZE, offset, ...filterArgs },
    { enabled: inSearch, placeholderData: keepPreviousData },
  );
  const similar = trpc.media.similar.useQuery(
    { uuid: url.similar ?? '', limit: PAGE_SIZE, offset, ...filterArgs },
    { enabled: inSimilar, placeholderData: keepPreviousData },
  );
  const playlist = trpc.playlist.get.useQuery(
    { uuid: url.playlist ?? '', limit: PAGE_SIZE, offset },
    { enabled: inPlaylist, placeholderData: keepPreviousData },
  );

  const loading =
    inPlaylist ? playlist.isLoading
    : inSimilar ? similar.isLoading
    : inSearch ? search.isLoading
    : recent.isLoading;

  const items: MediaItemDto[] =
    inPlaylist
      ? (playlist.data?.items
          .filter((it) => it.available)
          .map((it) => (it as unknown as { available: true; item: MediaItemDto }).item) ?? [])
      : inSimilar
        ? (similar.data?.items ?? [])
        : inSearch
          ? (search.data?.items ?? [])
          : (recent.data?.items ?? []);

  const hasMore =
    inPlaylist ? (playlist.data?.hasMore ?? false)
    : inSimilar ? (similar.data?.hasMore ?? false)
    : inSearch ? (search.data?.hasMore ?? false)
    : (recent.data?.hasMore ?? false);

  const totalCount = inPlaylist
    ? playlist.data?.totalCount
    : inRecent
      ? recent.data?.totalCount
      : undefined; // search/similar are top-K ranked — no meaningful total

  // Resolve the visible viewer item from current items + selection state.
  // If a postLoadIntent is set (after a cross-page navigation) and the
  // selected UUID isn't in this page's items yet, fall back to the first or
  // last item per the intent — this keeps the viewer showing the right item
  // through the page transition without a flash.
  const directIndex = selectedUuid
    ? items.findIndex((i) => i.uuid === selectedUuid)
    : -1;
  let selectedIndex = directIndex;
  let selected: MediaItemDto | null = directIndex >= 0 ? items[directIndex] : null;
  // Fallback during cross-page navigation. We deliberately do NOT gate on a
  // `loading` flag — React Query's `isLoading` flips true on a new
  // queryKey-fetch even when keepPreviousData provides displayable items,
  // which would briefly cause `selected` to be null and close the viewer.
  if (!selected && postLoadIntent && items.length > 0) {
    selectedIndex = postLoadIntent === 'first' ? 0 : items.length - 1;
    selected = items[selectedIndex];
  }

  // Once the page transition completes, sync state: write the new selection
  // back to `selectedUuid` and clear the intent.
  //
  // CRITICAL: we must only clear the intent once we've actually landed on a
  // *different* item. With `keepPreviousData`, `selected` will resolve to the
  // OLD page's item for one or more renders before the new page arrives — if
  // we clear `postLoadIntent` during that window, the fallback below stops
  // firing, and when the new data finally arrives `selected` becomes null and
  // the viewer closes. Hence the `selectedUuid !== selected.uuid` gate.
  useEffect(() => {
    if (!postLoadIntent || !selected) return;
    if (selectedUuid === selected.uuid) return;
    setSelectedUuid(selected.uuid);
    setPostLoadIntent(null);
  }, [postLoadIntent, selected, selectedUuid]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleOpen = (item: MediaItemDto, match?: { tStartMs: number | null }) => {
    if (match?.tStartMs != null) {
      // Search-hit click on a timestamped match — open viewer AND seek to
      // the match point in a single url.set so they propagate together.
      url.set({ item: item.uuid, tMs: match.tStartMs });
    } else {
      // Clear any stale `t` from a previous search-hit click so non-search
      // opens don't inherit a deep-link seek.
      url.set({ item: item.uuid, tMs: null });
    }
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
    setSelectionMode(false);
    setAnchor(null);
  };

  // "Selecting" is active when the mode is explicitly armed OR anything is
  // already selected (via the hover checkbox / cmd-click). In that state a plain
  // click on a thumbnail toggles its selection instead of opening the preview,
  // and the Select button shows pressed.
  const selecting = selectionMode || selection.length > 0;

  const toggleSelectionMode = () => {
    // Pressed (selecting) → exit and clear everything; otherwise arm the mode.
    if (selecting) clearSelection();
    else setSelectionMode(true);
  };

  // Cross-page navigation: at the boundary of the visible page, step into
  // the next (or previous) page and land on the first / last item there.
  // Slideshow mode adds wrap-around at the very end so playback loops.
  const onPrev = selectedIndex > 0
    ? () => setSelectedUuid(items[selectedIndex - 1].uuid)
    : (url.page > 1
        ? () => {
            setPostLoadIntent('last');
            url.set({ page: url.page - 1 });
          }
        : undefined);

  const atVeryEnd =
    selectedIndex >= 0 && selectedIndex >= items.length - 1 && !hasMore;
  const onNext = selectedIndex >= 0 && selectedIndex < items.length - 1
    ? () => setSelectedUuid(items[selectedIndex + 1].uuid)
    : hasMore
      ? () => {
          setPostLoadIntent('first');
          url.set({ page: url.page + 1 });
        }
      : slideshow && atVeryEnd && url.page > 1
        ? () => {
            // Loop: jump back to page 1 and land on its first item.
            setPostLoadIntent('first');
            url.set({ page: 1 });
          }
        : slideshow && atVeryEnd && items.length > 0
          ? () => setSelectedUuid(items[0].uuid)
          : undefined;

  const onSeeSimilar = (item: MediaItemDto) => {
    url.set({
      similar: item.uuid, query: '', playlist: null, person: null,
      item: null, view: null,
    });
  };

  const clearSimilar = () => url.set({ similar: null });

  const handleSearchSubmit = (q: string) => {
    url.set({ query: q, similar: q ? null : undefined, playlist: q ? null : undefined });
  };

  const handlePlaylistSelect = (uuid: string | null) => {
    // view:null clears slideshow (it's derived from view) along with the viewer.
    url.set({
      playlist: uuid, similar: null, query: '', person: null,
      item: null, view: null,
    });
    setSelection([]);
  };

  const handlePersonSelect = (uuid: string | null) => {
    url.set({
      person: uuid, playlist: null, similar: null,
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

  const goToPage = (page: number) => {
    url.set({ page });
    // Scroll to top on page change so users land at the first item.
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Like-count cache patch. Used by BOTH the local setLike mutation's
  // onSuccess AND the cross-session 'item.like' sync event, so a like
  // performed in another tab/device updates this session's cache without
  // a refetch (refetching would yank a now-viewed item out of an
  // unwatched-filtered list — see the matching comment in setLike below).
  const trpcUtils = trpc.useUtils();
  const queryClient = useQueryClient();
  const applyLikePatch = useCallback((uuid: string, count: number) => {
    const patchFlat = (old: unknown) => {
      if (!old || typeof old !== 'object') return old;
      const o = old as { items?: Array<{ uuid: string; likeCount: number } & Record<string, unknown>> };
      if (!Array.isArray(o.items)) return old;
      let changed = false;
      const items = o.items.map((it) => {
        if (it.uuid !== uuid) return it;
        changed = true;
        return { ...it, likeCount: count };
      });
      return changed ? { ...o, items } : old;
    };
    const patchPlaylist = (old: unknown) => {
      if (!old || typeof old !== 'object') return old;
      const o = old as { items?: Array<Record<string, unknown>> };
      if (!Array.isArray(o.items)) return old;
      let changed = false;
      const items = o.items.map((it) => {
        const wrapper = it as { available?: boolean; item?: { uuid?: string; likeCount?: number } & Record<string, unknown> };
        if (!wrapper.available || wrapper.item?.uuid !== uuid) return it;
        changed = true;
        return { ...wrapper, item: { ...wrapper.item, likeCount: count } };
      });
      return changed ? { ...o, items } : old;
    };
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
    const patchFlat = (old: unknown) => {
      if (!old || typeof old !== 'object') return old;
      const o = old as { items?: Array<{ uuid: string } & Record<string, unknown>> };
      if (!Array.isArray(o.items)) return old;
      let changed = false;
      const items = o.items.map((it) => {
        if (it.uuid !== uuid) return it;
        changed = true;
        return { ...it, rotation };
      });
      return changed ? { ...o, items } : old;
    };
    const patchPlaylist = (old: unknown) => {
      if (!old || typeof old !== 'object') return old;
      const o = old as { items?: Array<Record<string, unknown>> };
      if (!Array.isArray(o.items)) return old;
      let changed = false;
      const items = o.items.map((it) => {
        const wrapper = it as {
          available?: boolean;
          item?: { uuid?: string } & Record<string, unknown>;
        };
        if (!wrapper.available || wrapper.item?.uuid !== uuid) return it;
        changed = true;
        return { ...wrapper, item: { ...wrapper.item, rotation } };
      });
      return changed ? { ...o, items } : old;
    };
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
      <header className={`sticky top-0 z-30 bg-zinc-950/80 backdrop-blur border-b border-zinc-900 ${chromeQuietClass}`}>
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-4">
          <h1 className="shrink-0">
            <KenNookLogo height={26} />
            <span className="sr-only">KenNook</span>
          </h1>
          <div className="flex-1">
            <SearchBar initial={url.query} onSubmit={handleSearchSubmit} />
          </div>
          <button
            onClick={toggleSelectionMode}
            aria-pressed={selecting}
            className={`rounded px-3 py-1 text-sm transition shrink-0 flex items-center gap-1.5
                        ${selecting
                          ? 'bg-emerald-400 text-zinc-900 font-medium ring-1 ring-inset ring-emerald-600/70 translate-y-px shadow-[inset_0_2px_4px_rgba(0,0,0,0.35)]'
                          : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'}`}
            title={selecting ? 'Exit selection mode' : 'Enter selection mode'}
          >
            {selecting ? (
              <>
                <CheckIcon />
                {selection.length > 0 ? `Done · ${selection.length}` : 'Done'}
              </>
            ) : (
              <>
                <SelectIcon />
                Select
              </>
            )}
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
            className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800
                       rounded px-2 py-1 text-sm transition shrink-0"
          >
            ?
          </button>
          <AdminLinkButton />
          <LibrarySwitcher />
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 flex gap-8">
        <aside
          className={`hidden md:block w-56 shrink-0 sticky top-20 self-start
                     max-h-[calc(100vh-6rem)] overflow-y-auto pr-2 ${chromeQuietClass}`}
        >
          <PlaylistsSection
            activePlaylistUuid={url.playlist}
            onSelectPlaylist={handlePlaylistSelect}
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
        </aside>

        <div className="flex-1 min-w-0">
          <SelectionBar
            selection={selection}
            onClear={clearSelection}
            currentPlaylistUuid={inPlaylist ? url.playlist : null}
            currentPlaylistName={inPlaylist ? playlist.data?.playlist.name ?? null : null}
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

          {inSimilar && similar.data?.source && (
            <div className="mb-4 flex items-center gap-3 bg-zinc-900/60 border border-zinc-800
                            rounded-lg px-3 py-2">
              <img
                src={similar.data.source.thumbnailUrl}
                alt={similar.data.source.filename}
                className="w-10 h-10 object-cover rounded shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500">Similar to</div>
                <div className="text-sm text-zinc-200 truncate">
                  {similar.data.source.filename}
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

          {inPlaylist && playlist.data && (
            <div className="mb-4 flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-zinc-500 uppercase tracking-wider">Playlist</div>
                <div className="text-lg text-zinc-100 font-medium">{playlist.data.playlist.name}</div>
                <div className="text-sm text-zinc-500">
                  {playlist.data.totalCount} item{playlist.data.totalCount === 1 ? '' : 's'}
                </div>
              </div>
              {playlist.data.totalCount > 0 && (
                <div className="shrink-0 mt-1">
                  <PlayButton onClick={startSlideshow} />
                </div>
              )}
            </div>
          )}

          {inSearch && (
            <div className="mb-4 flex items-center gap-4">
              <div className="text-sm text-zinc-500 flex-1">
                Page {url.page} of results for{' '}
                <span className="text-zinc-300">&ldquo;{url.query}&rdquo;</span>
              </div>
              {items.length > 0 && <PlayButton onClick={startSlideshow} />}
            </div>
          )}

          {inSimilar && !similar.data?.source && (
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

          {/* Sort + shuffle — browse and search/similar (playlists keep their
              own order). Picking a sort clears shuffle; the shuffle toggle
              mints a fresh seed on, clears it off. */}
          {!inPlaylist && (
            <div className="flex justify-end mb-3">
              <SortControl
                sort={url.sort}
                shuffle={url.shuffle}
                relevanceMode={inSearch || inSimilar}
                onSelectSort={(key) => url.set({ sort: key, shuffle: null })}
                onToggleShuffle={() =>
                  url.set({ shuffle: url.shuffle != null ? null : Math.floor(Math.random() * 2_000_000_000) })
                }
              />
            </div>
          )}

          <MediaGrid
            items={items}
            onSelect={handleOpen}
            onToggleSelection={handleToggleSelection}
            selectedKeys={selectedKeys}
            selectionMode={selecting}
            onSetLikes={handleSetLikes}
            loading={loading}
          />

          <Pagination
            page={url.page}
            hasMore={hasMore}
            totalCount={totalCount}
            pageSize={PAGE_SIZE}
            onPageChange={goToPage}
          />
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
        // Exit slideshow but stay fullscreen — drop view 'slideshow' → 'full'.
        onSlideshowExit={() => url.set({ view: 'full' })}
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

function SelectIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" strokeDasharray="2 1.5" />
      <path d="M5.5 8 L7.5 10 L11 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M3 6 L5 8 L9 4" strokeLinecap="round" strokeLinejoin="round" />
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
