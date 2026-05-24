'use client';

/**
 * In-memory + localStorage-backed preferences store.
 *
 * Shape: a single typed object, one key per pref. Every preference has a
 * default. Reading a missing or invalid value falls back to the default.
 *
 * Storage strategy (per device, single user for now):
 *   - Single localStorage key holds the JSON blob
 *   - React state mirrors it for live updates within the session
 *   - `usePreference(key)` reads + writes a single field; updates persist
 *
 * Forward compat: when multi-device sync arrives, this hook's call sites
 * stay the same. We swap the storage layer for a server-backed mutation
 * + websocket (or polling) for cross-device updates.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

// ─── Schema ─────────────────────────────────────────────────────────────

export interface Preferences {
  /** Video playback */
  videoMuted: boolean;
  videoVolume: number;       // 0.0 – 1.0
  videoPlaybackRate: number; // 1.0 normal; 0.5/1.5/2.0 etc.
  /** Default fit when entering maxed video/photo mode. */
  defaultFit: 'cover' | 'contain';
  /** Whether the AI metadata section in the viewer sidebar opens expanded. */
  detailsExpanded: boolean;
  /** Per-photo dwell time in slideshow mode (milliseconds). */
  slideshowPhotoMs: number;
}

const DEFAULTS: Preferences = {
  videoMuted: false,
  videoVolume: 1.0,
  videoPlaybackRate: 1.0,
  defaultFit: 'cover',
  detailsExpanded: true,
  slideshowPhotoMs: 5500,
};

const STORAGE_KEY = 'kennook.preferences.v1';

// ─── Storage helpers ────────────────────────────────────────────────────

function loadFromStorage(): Preferences {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    // Merge with defaults so newly-added keys get sane fallbacks for users
    // whose existing blob predates the field.
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function saveToStorage(prefs: Preferences) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage quota or private-mode rejection — preferences just won't persist
    // this session. Not worth surfacing to the user.
  }
}

// ─── Context + Provider ─────────────────────────────────────────────────

interface PreferencesCtx {
  prefs: Preferences;
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  reset: () => void;
}

const PreferencesContext = createContext<PreferencesCtx>({
  prefs: DEFAULTS,
  set: () => {},
  reset: () => {},
});

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  // SSR: start with DEFAULTS to match server-rendered HTML. Hydrate after
  // mount via useEffect, avoiding a hydration mismatch warning.
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);

  useEffect(() => {
    setPrefs(loadFromStorage());
  }, []);

  // Cross-tab sync: when another tab changes preferences, mirror the update.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setPrefs(loadFromStorage());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const set = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      setPrefs((p) => {
        const next = { ...p, [key]: value };
        saveToStorage(next);
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    setPrefs(DEFAULTS);
    saveToStorage(DEFAULTS);
  }, []);

  const value = useMemo(() => ({ prefs, set, reset }), [prefs, set, reset]);
  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

// ─── Hooks ──────────────────────────────────────────────────────────────

export function usePreferences() {
  return useContext(PreferencesContext);
}

/**
 * Read + write a single preference. Tuple matches React's useState shape.
 *
 *   const [muted, setMuted] = usePreference('videoMuted');
 */
export function usePreference<K extends keyof Preferences>(key: K) {
  const { prefs, set } = useContext(PreferencesContext);
  const setter = useCallback((value: Preferences[K]) => set(key, value), [set, key]);
  return [prefs[key], setter] as const;
}
