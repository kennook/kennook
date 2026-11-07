'use client';

/**
 * Quick bookmark picker — a vertical wheel of your most-used bookmark tags that
 * you step through with the keyboard. Open it with the `viewer.bookmarkWheel`
 * shortcut (⇧↑/⇧↓ by default) on a playing video; ⇧↑/⇧↓ move through the tags,
 * Enter commits the centered one at the moment you opened it (no typing), Esc
 * cancels. Dwell ~2s on a tag and it commits on its own. The first and last
 * entries are "Cancel".
 *
 * Keyboard-only by design: a scroll-wheel gesture used to open it too, but that
 * fired too easily during normal scrolling, so it was removed in favour of the
 * explicit shortcut. Self-contained — it listens on `window` and never covers
 * the real controls.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { getBindings, matchesBinding, useBindingsVersion } from '@/lib/shortcuts';

const DWELL_MS = 2000;        // settle this long on an item to commit it
const COMMIT_ANIM_MS = 550;   // "saved" flourish before it closes
const SLOTS = [-2, -1, 0, 1, 2] as const;

interface WheelItem { dismiss: boolean; label: string }
interface Props {
  labels: string[];
  getCurrentMs: () => number;
  onCommit: (timeMs: number, label: string) => void;
  /** Called when the wheel opens (used to pin the controls visible). */
  onOpen?: () => void;
  /** Identifies the current video; when it changes (slideshow advance, prev/next)
   *  an open wheel is cancelled so it can't commit onto the wrong clip. */
  videoKey?: string;
}

export function BookmarkWheel({ labels, getCurrentMs, onCommit, onOpen, videoKey }: Props) {
  const [wheel, setWheel] = useState<{ index: number; committing: string | null } | null>(null);

  const items = useMemo<WheelItem[]>(() => [
    { dismiss: true, label: 'Cancel' },
    ...labels.map((l) => ({ dismiss: false, label: l })),
    { dismiss: true, label: 'Cancel' },
  ], [labels]);

  // Refs so the once-mounted window listeners always see fresh values.
  const wheelRef = useRef(wheel); wheelRef.current = wheel;
  const itemsRef = useRef(items); itemsRef.current = items;
  const onCommitRef = useRef(onCommit); onCommitRef.current = onCommit;
  const getMsRef = useRef(getCurrentMs); getMsRef.current = getCurrentMs;
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  const msRef = useRef(0);
  const dwellRef = useRef<number | null>(null);
  const commitTimerRef = useRef<number | null>(null);

  // Re-resolve the shortcut binding when any override tier changes.
  const bindingsVersion = useBindingsVersion();

  // Video changed under an open wheel → cancel it, so a dwell (or an in-flight
  // commit flourish) can't bookmark the wrong clip at a stale timestamp.
  useEffect(() => {
    wheelRef.current = null;
    setWheel(null);
    if (dwellRef.current) { window.clearTimeout(dwellRef.current); dwellRef.current = null; }
    if (commitTimerRef.current) { window.clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
  }, [videoKey]);

  useEffect(() => {
    const wheelKeys = getBindings('viewer.bookmarkWheel');
    const set = (v: { index: number; committing: string | null } | null) => { wheelRef.current = v; setWheel(v); };
    const clearDwell = () => { if (dwellRef.current) { window.clearTimeout(dwellRef.current); dwellRef.current = null; } };
    const dismiss = () => { clearDwell(); set(null); };
    // Open the wheel at the current moment, starting on the first (most-used) tag.
    const openWheel = () => {
      msRef.current = getMsRef.current();
      onOpenRef.current?.();
      set({ index: 1, committing: null });
      arm(1);
    };
    const fire = (index: number) => {
      const item = itemsRef.current[index];
      if (!item || item.dismiss) { dismiss(); return; }
      set({ index, committing: item.label }); // play the "saved" flourish, then commit
      clearDwell();
      commitTimerRef.current = window.setTimeout(() => {
        commitTimerRef.current = null;
        onCommitRef.current(msRef.current, item.label);
        set(null);
      }, COMMIT_ANIM_MS);
    };
    const arm = (index: number) => { clearDwell(); dwellRef.current = window.setTimeout(() => fire(index), DWELL_MS); };

    const onKey = (e: KeyboardEvent) => {
      // Open + move the wheel from the keyboard (no cursor involved). Direction
      // comes from the key (↑/← = back, ↓/→ = forward).
      if (wheelKeys.some((k) => matchesBinding(e, k))) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const items = itemsRef.current;
        const active = wheelRef.current;
        if (!active) {
          if (items.length <= 2) return; // no tags to pick → let the key do its default
          e.preventDefault();
          e.stopPropagation();
          openWheel();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (active.committing) return; // frozen during the save flourish
        const dir = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1;
        const next = Math.min(items.length - 1, Math.max(0, active.index + dir));
        if (next !== active.index) set({ index: next, committing: null });
        arm(next);
        return;
      }

      const active = wheelRef.current;
      if (!active) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss();
      } else if (e.key === 'Enter') {
        // Commit the centered option now instead of waiting out the dwell.
        e.stopPropagation();
        e.preventDefault();
        if (!active.committing) fire(active.index);
      }
    };

    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      clearDwell();
      if (commitTimerRef.current) { window.clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
    };
  }, [bindingsVersion]);

  if (!wheel) return null;

  return (
    // Centered over the video, large + translucent so it reads as an ambient
    // "hidden" overlay you can still see the video through.
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 xl:gap-4">
      {SLOTS.map((off) => {
        const item = items[wheel.index + off];
        if (!item) return <div key={off} className="h-12 xl:h-24" />; // empty slot past the ends
        const dist = Math.abs(off);
        const scale = dist === 0 ? 1 : dist === 1 ? 0.66 : 0.44;
        const opacity = dist === 0 ? 0.92 : dist === 1 ? 0.45 : 0.2;
        const center = off === 0;
        const committing = center && wheel.committing;
        // ~2x bigger on larger screens (xl+).
        const base = 'px-8 py-3 xl:px-16 xl:py-6 rounded-2xl text-4xl xl:text-7xl font-semibold whitespace-nowrap transition-all duration-150 drop-shadow-lg backdrop-blur-sm';
        // Options are dark black (40% transparent); the one being committed turns green.
        const tone = committing
          ? 'bg-emerald-500/50 text-white ring-1 ring-emerald-300/50'
          : 'bg-black/60 text-white ring-1 ring-white/10';
        return (
          // On commit the selected tag keeps its label and just pulses (kn-bm-pop).
          <div key={off} style={{ transform: `scale(${scale})`, opacity }}
               className={`${base} ${tone} ${committing ? 'kn-bm-pop' : ''}`}>
            {item.dismiss ? '✕ Cancel' : item.label}
          </div>
        );
      })}
    </div>
  );
}
