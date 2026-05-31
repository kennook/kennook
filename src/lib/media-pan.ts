'use client';

/**
 * Per-item viewer-state memory, persisted to localStorage.
 *
 * Each entry is keyed by "<library_slug>:<item_uuid>" — globally
 * unique across the user's library — and stores pan + zoom. Capped
 * LRU-style by `updatedAt` so the map can't bloat.
 *
 * The default view (pan 0, zoom 1) is NOT stored; writing the default
 * removes any prior entry. Keeps the map sparse — most items the user
 * never adjusts.
 *
 * Schema is forward-compatible: an entry without a `zoom` field loads
 * with zoom = 1, so pan-only entries written by earlier builds keep
 * working.
 *
 * Storage scope: localStorage is per-browser-per-origin, so for a
 * single user on a single browser this IS per-user. Cross-device sync
 * would require server storage (parked — distribution infra discussion).
 */

interface Entry {
  x: number;
  y: number;
  zoom?: number; // optional for back-compat with pre-zoom entries
  updatedAt: number;
}

type ViewMap = Record<string, Entry>;

const STORAGE_KEY = 'kennook.media-pan.v1';
const MAX_ENTRIES = 200;

function load(): ViewMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ViewMap;
  } catch {
    return {};
  }
}

function persist(map: ViewMap) {
  if (typeof window === 'undefined') return;
  let payload = map;
  const entries = Object.entries(map);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    payload = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode — silently ignore
  }
}

export interface MediaView {
  x: number;
  y: number;
  zoom: number;
}

export function getMediaView(key: string): MediaView | null {
  const map = load();
  const entry = map[key];
  if (!entry) return null;
  return { x: entry.x, y: entry.y, zoom: entry.zoom ?? 1 };
}

export function setMediaView(key: string, view: MediaView) {
  const map = load();
  // Default view (centered + cover-zoom) — don't waste a slot on it.
  // Also delete any existing entry that's been reset to default.
  if (view.x === 0 && view.y === 0 && view.zoom === 1) {
    if (!(key in map)) return;
    delete map[key];
    persist(map);
    return;
  }
  map[key] = { x: view.x, y: view.y, zoom: view.zoom, updatedAt: Date.now() };
  persist(map);
}

// Back-compat shims for code that only needs pan. Read returns x/y;
// write preserves any existing zoom (doesn't trample it).
export function getMediaPan(key: string): { x: number; y: number } | null {
  const v = getMediaView(key);
  return v ? { x: v.x, y: v.y } : null;
}
export function setMediaPan(key: string, pan: { x: number; y: number }) {
  const existing = getMediaView(key);
  setMediaView(key, { ...pan, zoom: existing?.zoom ?? 1 });
}
