'use client';

/**
 * Per-video playback-position memory, persisted to localStorage.
 *
 * Each entry is keyed by "<workspace_slug>:<item_uuid>" — globally unique
 * across all videos in the user's library. The map is capped at MAX_ENTRIES
 * and evicted LRU-style by `updatedAt` when full, so it never bloats no
 * matter how many videos the user passes through.
 *
 * Why localStorage (and not the user.db):
 *   - Per-device — different machines watch at different paces
 *   - Single-user for v0.1; trivially migratable to user.db when auth lands
 *   - Same pattern as `lib/preferences.tsx`
 */

interface Entry {
  time: number;
  updatedAt: number;
}

type ProgressMap = Record<string, Entry>;

const STORAGE_KEY = 'kennook.video-progress.v1';
const MAX_ENTRIES = 200;

function load(): ProgressMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ProgressMap;
  } catch {
    return {};
  }
}

function persist(map: ProgressMap) {
  if (typeof window === 'undefined') return;
  let payload = map;
  const entries = Object.entries(map);
  if (entries.length > MAX_ENTRIES) {
    // LRU evict: keep the most recently updated MAX_ENTRIES.
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    payload = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode — silently ignore; in-memory writes still work
    // for the current session.
  }
}

export function getVideoProgress(key: string): number | null {
  const map = load();
  const entry = map[key];
  return entry?.time ?? null;
}

export function setVideoProgress(key: string, time: number) {
  const map = load();
  map[key] = { time, updatedAt: Date.now() };
  persist(map);
}

export function clearVideoProgress(key: string) {
  const map = load();
  if (!(key in map)) return;
  delete map[key];
  persist(map);
}
