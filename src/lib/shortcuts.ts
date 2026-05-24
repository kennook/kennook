'use client';

import { useEffect, useRef } from 'react';

// ─── Registry ──────────────────────────────────────────────────────────────

export type ShortcutCategory = 'navigation' | 'viewer' | 'video' | 'global';

export interface ShortcutDef {
  id: string;
  label: string;
  category: ShortcutCategory;
  defaultKeys: string[]; // matched against KeyboardEvent.key
  description?: string;
  /**
   * True if this shortcut supports tap-vs-hold semantics (e.g. ←/→ where tap
   * navigates and hold scrubs). Documented here for the help UI; behavior is
   * driven by useTapOrHold() at the call site.
   */
  holdable?: boolean;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  // Navigation
  {
    id: 'nav.prevItem',
    label: 'Previous item',
    category: 'navigation',
    defaultKeys: ['ArrowUp'],
  },
  {
    id: 'nav.nextItem',
    label: 'Next item',
    category: 'navigation',
    defaultKeys: ['ArrowDown'],
  },

  // Viewer
  { id: 'viewer.close',      label: 'Close',                   category: 'viewer', defaultKeys: ['Escape'] },
  { id: 'viewer.maximize',   label: 'Toggle maximize',         category: 'viewer', defaultKeys: ['f', 'F'] },
  { id: 'viewer.fitToggle',  label: 'Toggle fit / fill',       category: 'viewer', defaultKeys: ['c', 'C'], description: 'Only in maximize mode' },
  { id: 'viewer.zoomIn',     label: 'Zoom in',                 category: 'viewer', defaultKeys: ['+', '='], description: 'Maximize mode only · ranges 100%–400%' },
  { id: 'viewer.zoomOut',    label: 'Zoom out',                category: 'viewer', defaultKeys: ['-', '_'], description: 'Maximize mode only · clamped at 100% (use C for Fit)' },
  { id: 'viewer.like',       label: 'Like (rating +1)',        category: 'viewer', defaultKeys: ['l', 'L'], description: 'Cycles 0 → 5 → 0' },
  { id: 'viewer.voiceTag',   label: 'Voice-tag (hold)',        category: 'viewer', defaultKeys: ['v', 'V'], description: 'Hold to record; release to auto-tag from speech', holdable: true },
  { id: 'viewer.slideshowSlower', label: 'Slideshow: slow down', category: 'viewer', defaultKeys: [','], description: 'Slideshow mode only · +1s per photo' },
  { id: 'viewer.slideshowFaster', label: 'Slideshow: speed up',  category: 'viewer', defaultKeys: ['.'], description: 'Slideshow mode only · −1s per photo' },

  // Video playback
  { id: 'video.playPause',     label: 'Play / pause',          category: 'video', defaultKeys: [' ', 'k', 'K'] },
  { id: 'video.seekBack10',    label: 'Back 10 seconds',       category: 'video', defaultKeys: ['ArrowLeft'] },
  { id: 'video.seekForward10', label: 'Forward 10 seconds',    category: 'video', defaultKeys: ['ArrowRight'] },
  { id: 'video.mute',          label: 'Mute / unmute',         category: 'video', defaultKeys: ['m', 'M'] },
  { id: 'video.jumpToPercent', label: 'Jump to 0–90%',         category: 'video', defaultKeys: ['0','1','2','3','4','5','6','7','8','9'] },
  { id: 'video.undoSeek',      label: 'Undo last seek',        category: 'video', defaultKeys: ['u', 'U'], description: 'Jumps back to the position before your last seek (up to 5 steps)' },

  // Global
  { id: 'global.help', label: 'Show keyboard shortcuts', category: 'global', defaultKeys: ['?'] },
  { id: 'global.screensaver', label: 'Show screensaver', category: 'global', defaultKeys: ['s', 'S'], description: 'Walk-away mode — any input exits' },
];

const SHORTCUT_BY_ID: Record<string, ShortcutDef> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s]),
);

// ─── Persistence (forward-compatible with a future settings UI) ────────────

const STORAGE_KEY = 'kennook.shortcuts.v1';
type BindingMap = Record<string, string[]>;

function loadUserBindings(): BindingMap {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as BindingMap;
  } catch {
    return {};
  }
}

function saveUserBindings(b: BindingMap) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
}

export function getBindings(id: string): string[] {
  const user = loadUserBindings();
  if (user[id]?.length) return user[id];
  return SHORTCUT_BY_ID[id]?.defaultKeys ?? [];
}

export function setBinding(id: string, keys: string[]) {
  const user = loadUserBindings();
  user[id] = keys;
  saveUserBindings(user);
}

export function resetAllBindings() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return true;
  if (t.isContentEditable) return true;
  return false;
}

/** Format a key for display in the help overlay. */
export function formatKey(k: string): string {
  if (k === ' ') return 'Space';
  if (k === 'ArrowLeft') return '←';
  if (k === 'ArrowRight') return '→';
  if (k === 'ArrowUp') return '↑';
  if (k === 'ArrowDown') return '↓';
  if (k === 'Escape') return 'Esc';
  if (k.length === 1) return k.toUpperCase();
  return k;
}

// ─── Hook: simple keydown handler ──────────────────────────────────────────

export function useShortcut(
  id: string,
  handler: (e: KeyboardEvent) => void,
  options: { enabled?: boolean } = {},
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const keys = getBindings(id);

    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (keys.includes(e.key)) handlerRef.current(e);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, enabled]);
}

// ─── Hook: tap-vs-hold ─────────────────────────────────────────────────────

export interface TapOrHoldOptions {
  /** Fired on keyup if the key was released within the hold threshold. */
  onTap?: () => void;
  /** Fired once when the hold threshold is crossed. */
  onHoldStart?: () => void;
  /**
   * Fired on every animation frame while the key is held.
   * @param elapsedMs ms since hold started (i.e., since the threshold crossed)
   * @param frameDeltaMs ms since the previous onHoldFrame call (refresh-rate independent)
   */
  onHoldFrame?: (elapsedMs: number, frameDeltaMs: number) => void;
  /** Fired when the key is released after a hold. */
  onHoldEnd?: () => void;
  /** How long the key must be held before "hold" semantics kick in. */
  holdThresholdMs?: number;
  enabled?: boolean;
}

export function useTapOrHold(id: string, opts: TapOrHoldOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const enabled = opts.enabled !== false;
  const holdMs = opts.holdThresholdMs ?? 250;

  useEffect(() => {
    if (!enabled) return;
    const keys = getBindings(id);

    let pressed = false;
    let downAt = 0;
    let holding = false;
    let rafId = 0;

    const startHoldLoop = () => {
      holding = true;
      const holdStartedAt = performance.now();
      let lastFrameAt = holdStartedAt;
      optsRef.current.onHoldStart?.();
      const tick = () => {
        if (!holding) return;
        const now = performance.now();
        const elapsedMs = now - holdStartedAt;
        const frameDeltaMs = now - lastFrameAt;
        lastFrameAt = now;
        optsRef.current.onHoldFrame?.(elapsedMs, frameDeltaMs);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    };

    const stopHoldLoop = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (holding) {
        holding = false;
        optsRef.current.onHoldEnd?.();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (!keys.includes(e.key)) return;
      e.preventDefault(); // suppress browser default (scroll, etc.)
      if (pressed) return; // ignore keyboard autorepeat
      pressed = true;
      downAt = performance.now();

      window.setTimeout(() => {
        if (pressed && !holding) startHoldLoop();
      }, holdMs);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!keys.includes(e.key)) return;
      const elapsed = performance.now() - downAt;
      const wasHolding = holding;
      pressed = false;
      stopHoldLoop();
      if (!wasHolding && elapsed < holdMs) optsRef.current.onTap?.();
    };

    // If the window loses focus while a key is held (e.g. cmd-tab), stop
    // holding so the loop doesn't run forever in the background.
    const onBlur = () => {
      pressed = false;
      stopHoldLoop();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      stopHoldLoop();
    };
  }, [id, enabled, holdMs]);
}
