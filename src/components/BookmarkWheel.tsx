'use client';

/**
 * Quick bookmark picker — an "easter-egg" scroll wheel over the video controls.
 * Scroll the mouse wheel in the bottom controls band of a playing video and a
 * vertical wheel of your most-used bookmark tags appears; keep scrolling to move
 * through them; dwell ~3s on one and it's saved at the moment you opened the
 * wheel (no typing). The first and last entries are "Cancel"; mousing out of the
 * controls area or pressing Escape also dismisses.
 *
 * Self-contained: it listens on `window` (gated to the container's bottom band by
 * the event's own coordinates) rather than covering the controls with a div, so
 * it never blocks clicks on the real scrubber/buttons.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

const TRIGGER_BAND_PX = 300;  // bottom band that opens the wheel — covers the controls + thumbnail reel
const KEEP_REGION_PX = 380;   // leaving this bottom region dismisses (a margin above the trigger band)
const DWELL_MS = 2000;        // settle this long on an item to commit it
const COMMIT_ANIM_MS = 550;   // "saved" flourish before it closes
const MOVE_COOLDOWN_MS = 85; // throttle wheel → one step per interval so it's easy to land on one
const SLOTS = [-2, -1, 0, 1, 2] as const;

interface WheelItem { dismiss: boolean; label: string }
interface Props {
  containerRef: React.RefObject<HTMLElement | null>;
  labels: string[];
  getCurrentMs: () => number;
  onCommit: (timeMs: number, label: string) => void;
  /** Called when the wheel opens (used to pin the controls visible). */
  onOpen?: () => void;
  /** Identifies the current video; when it changes (slideshow advance, prev/next)
   *  an open wheel is cancelled so it can't commit onto the wrong clip. */
  videoKey?: string;
}

export function BookmarkWheel({ containerRef, labels, getCurrentMs, onCommit, onOpen, videoKey }: Props) {
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
  const lastMoveRef = useRef(0);

  // Video changed under an open wheel → cancel it, so a dwell (or an in-flight
  // commit flourish) can't bookmark the wrong clip at a stale timestamp.
  useEffect(() => {
    wheelRef.current = null;
    setWheel(null);
    if (dwellRef.current) { window.clearTimeout(dwellRef.current); dwellRef.current = null; }
    if (commitTimerRef.current) { window.clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
  }, [videoKey]);

  useEffect(() => {
    const set = (v: { index: number; committing: string | null } | null) => { wheelRef.current = v; setWheel(v); };
    const clearDwell = () => { if (dwellRef.current) { window.clearTimeout(dwellRef.current); dwellRef.current = null; } };
    const dismiss = () => { clearDwell(); set(null); };
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

    const bandRect = () => containerRef.current?.getBoundingClientRect() ?? null;

    const onWheel = (e: WheelEvent) => {
      const rect = bandRect();
      if (!rect) return;
      const items = itemsRef.current;
      const active = wheelRef.current;
      if (!active) {
        const inBand = e.clientX >= rect.left && e.clientX <= rect.right
          && e.clientY >= rect.bottom - TRIGGER_BAND_PX && e.clientY <= rect.bottom;
        if (!inBand || items.length <= 2) return; // outside band or no tags → let it scroll
        e.preventDefault();
        msRef.current = getMsRef.current();
        lastMoveRef.current = performance.now(); // grace before the first step
        onOpenRef.current?.();
        set({ index: 1, committing: null }); // start on the first (most-used) tag
        arm(1);
        return;
      }
      e.preventDefault();
      if (active.committing) return; // frozen during the save flourish
      // Throttle: advance at most one item per MOVE_COOLDOWN_MS regardless of how
      // fast the wheel fires (trackpads/hi-res wheels emit many events), so it's
      // easy to land on one. Any scroll still re-arms the dwell so it won't commit
      // mid-scroll.
      const now = performance.now();
      if (now - lastMoveRef.current >= MOVE_COOLDOWN_MS) {
        lastMoveRef.current = now;
        const dir = e.deltaY > 0 ? 1 : -1;
        const next = Math.min(items.length - 1, Math.max(0, active.index + dir));
        if (next !== active.index) set({ index: next, committing: null });
        arm(next);
      } else {
        arm(active.index);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!wheelRef.current) return;
      const rect = bandRect();
      if (!rect) return;
      const inKeep = e.clientX >= rect.left && e.clientX <= rect.right
        && e.clientY >= rect.bottom - KEEP_REGION_PX && e.clientY <= rect.bottom;
      if (!inKeep) dismiss(); // moused out of the controls section
    };

    const onKey = (e: KeyboardEvent) => {
      if (wheelRef.current && e.key === 'Escape') { e.stopPropagation(); dismiss(); }
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey, { capture: true });
      clearDwell();
      if (commitTimerRef.current) { window.clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
    };
  }, [containerRef]);

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
        // Options are dark black (20% transparent); the one being committed turns green.
        const tone = committing
          ? 'bg-emerald-500/50 text-white ring-1 ring-emerald-300/50'
          : 'bg-black/80 text-white ring-1 ring-white/10';
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
