'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback } from 'react';

export type Kind = 'photo' | 'video';
export type Orientation = 'portrait' | 'landscape' | 'square';
export type Watched = 'watched' | 'unwatched';
export type SensitiveFilter = 'hide' | 'only';

/**
 * Everything that determines what's shown on the page, encoded in the URL.
 *
 * Three view modes — playlist > similar > search > recent (the last one is
 * the default when none of the others are set).
 */
export interface PageState {
  query: string;
  similar: string | null;
  playlist: string | null;
  person: string | null;
  kind: Kind | null;
  orientation: Orientation | null;
  cameraMake: string | null;
  year: number | null;
  tags: string[];
  /** "Mentioned" tags from transcripts (source='transcript') — what's SAID. */
  mentioned: string[];
  minLikes: number | null;
  watched: Watched | null;
  sensitive: SensitiveFilter | null;
  /** Active library slug. Lives in the URL (not just the cookie) so each
   *  tab has its own source of truth — fixes a cross-tab leak where flipping
   *  libraries in one tab silently changed the next tab's reload. */
  library: string | null;
  page: number;
  /** UUID of the currently-open item in the viewer, or null when the
   *  viewer is closed. Reflects the modal-style preview/maxed state
   *  in the URL so it's bookmarkable and survives browser back/forward. */
  item: string | null;
  /** Viewer presentation mode. `null` = preview-modal; `'full'` = maxed
   *  fullscreen; `'slideshow'` = maxed + auto-advancing slideshow. Kept in
   *  the URL so it survives overlays (screensaver) and refreshes. Only
   *  meaningful when `item` is set. */
  view: 'full' | 'slideshow' | null;
  /** Initial seek position (ms) for the open viewer. Search-result clicks
   *  on a timestamped text match set this so the viewer opens at the match
   *  point. Null = no auto-seek. */
  tMs: number | null;
}

// Keys we manage in the URL. Anything not in this list is left alone, so other
// libraries (analytics, etc.) can drop their own params without us clobbering.
// `ws` is the pre-rename library key — we still read it but always write `lib`.
const ALL_KEYS = ['q', 'similar', 'playlist', 'person', 'kind', 'orientation', 'camera', 'year', 'tags', 'mentioned', 'likes', 'seen', 'sensitive', 'lib', 'ws', 'page', 'item', 'view', 't'] as const;
type UrlKey = typeof ALL_KEYS[number];

// Keys that DON'T reset `page` when they change — these don't alter
// the underlying list, just what's currently shown over it (the
// viewer modal). Same idea as `preservePage: true` but applied
// automatically for these specific keys.
const VIEWPORT_KEYS = new Set(['page', 'item', 'view', 'tMs']);

function parseState(params: URLSearchParams): PageState {
  const tagsRaw = params.get('tags');
  const mentionedRaw = params.get('mentioned');
  const yearRaw = params.get('year');
  const pageRaw = params.get('page');
  const likesRaw = params.get('likes');
  const seenRaw = params.get('seen');
  return {
    query: params.get('q') ?? '',
    similar: params.get('similar'),
    playlist: params.get('playlist'),
    person: params.get('person'),
    kind: (params.get('kind') as Kind | null) ?? null,
    orientation: (params.get('orientation') as Orientation | null) ?? null,
    cameraMake: params.get('camera'),
    year: yearRaw ? parseInt(yearRaw, 10) : null,
    tags: tagsRaw ? tagsRaw.split(',').filter(Boolean) : [],
    mentioned: mentionedRaw ? mentionedRaw.split(',').filter(Boolean) : [],
    minLikes: likesRaw ? Math.max(1, Math.min(5, parseInt(likesRaw, 10))) : null,
    watched: seenRaw === 'watched' || seenRaw === 'unwatched' ? seenRaw : null,
    sensitive: (() => {
      const s = params.get('sensitive');
      return s === 'hide' || s === 'only' ? s : null;
    })(),
    // Prefer the new `lib` key; fall back to legacy `ws` for old bookmarks.
    library: params.get('lib') ?? params.get('ws'),
    page: pageRaw ? Math.max(1, parseInt(pageRaw, 10)) : 1,
    item: params.get('item'),
    view: (() => {
      const v = params.get('view');
      return v === 'full' || v === 'slideshow' ? v : null;
    })(),
    tMs: (() => {
      const raw = params.get('t');
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    })(),
  };
}

function writeKey(params: URLSearchParams, key: UrlKey, value: unknown) {
  if (value === null || value === undefined || value === '' ||
      (Array.isArray(value) && value.length === 0)) {
    params.delete(key);
    return;
  }
  if (Array.isArray(value)) params.set(key, value.join(','));
  else params.set(key, String(value));
}

function applyPatchToParams(
  base: URLSearchParams,
  patch: Partial<PageState>,
): URLSearchParams {
  const out = new URLSearchParams(base);
  // Map state keys → URL keys.
  if ('query' in patch) writeKey(out, 'q', patch.query);
  if ('similar' in patch) writeKey(out, 'similar', patch.similar);
  if ('playlist' in patch) writeKey(out, 'playlist', patch.playlist);
  if ('person' in patch) writeKey(out, 'person', patch.person);
  if ('kind' in patch) writeKey(out, 'kind', patch.kind);
  if ('orientation' in patch) writeKey(out, 'orientation', patch.orientation);
  if ('cameraMake' in patch) writeKey(out, 'camera', patch.cameraMake);
  if ('year' in patch) writeKey(out, 'year', patch.year);
  if ('tags' in patch) writeKey(out, 'tags', patch.tags);
  if ('mentioned' in patch) writeKey(out, 'mentioned', patch.mentioned);
  if ('minLikes' in patch) writeKey(out, 'likes', patch.minLikes);
  if ('watched' in patch) writeKey(out, 'seen', patch.watched);
  if ('sensitive' in patch) writeKey(out, 'sensitive', patch.sensitive);
  if ('library' in patch) {
    // Write the new key and clear the legacy one so old `?ws=` doesn't linger.
    writeKey(out, 'lib', patch.library);
    out.delete('ws');
  }
  if ('page' in patch) writeKey(out, 'page', patch.page);
  if ('item' in patch) writeKey(out, 'item', patch.item);
  if ('view' in patch) writeKey(out, 'view', patch.view);
  if ('tMs' in patch) writeKey(out, 't', patch.tMs);
  return out;
}

/**
 * Reads URL → state, returns the state + a single `set(patch)` mutator.
 *
 * Any state change other than the page itself automatically resets `page` to
 * 1 — so changing filters/query never strands you on a (now-empty) page 5.
 */
export function usePageState() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const state = parseState(searchParams);

  const set = useCallback(
    (patch: Partial<PageState>, options?: { preservePage?: boolean }) => {
      const params = applyPatchToParams(searchParams, patch);
      // If anything BUT page changed, drop back to page 1 — unless the
      // caller explicitly opts out (used for "back-fill the URL with the
      // current library on first load" where we're not really
      // navigating, just anchoring this tab's state).
      if (!options?.preservePage) {
        // Viewport keys (item/view) DON'T reset page either — opening
        // the viewer or maximizing it shouldn't jump the user back to
        // page 1 of their list.
        const resetting = Object.keys(patch).filter((k) => !VIEWPORT_KEYS.has(k));
        if (resetting.length > 0) params.delete('page');
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  return { ...state, set };
}
