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

const TRIGGER_BAND_PX = 96;   // bottom band of the video where a wheel opens it
const KEEP_REGION_PX = 280;   // leaving this bottom region dismisses (incl. the wheel)
const DWELL_MS = 3000;        // settle this long on an item to commit it
const COMMIT_ANIM_MS = 550;   // "saved" flourish before it closes
const SLOTS = [-2, -1, 0, 1, 2] as const;

interface WheelItem { dismiss: boolean; label: string }
interface Props {
  containerRef: React.RefObject<HTMLElement | null>;
  labels: string[];
  getCurrentMs: () => number;
  onCommit: (timeMs: number, label: string) => void;
  /** Called when the wheel opens (used to pin the controls visible). */
  onOpen?: () => void;
}

export function BookmarkWheel({ containerRef, labels, getCurrentMs, onCommit, onOpen }: Props) {
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

  useEffect(() => {
    const set = (v: { index: number; committing: string | null } | null) => { wheelRef.current = v; setWheel(v); };
    const clearDwell = () => { if (dwellRef.current) { window.clearTimeout(dwellRef.current); dwellRef.current = null; } };
    const dismiss = () => { clearDwell(); set(null); };
    const fire = (index: number) => {
      const item = itemsRef.current[index];
      if (!item || item.dismiss) { dismiss(); return; }
      set({ index, committing: item.label }); // play the "saved" flourish, then commit
      clearDwell();
      window.setTimeout(() => { onCommitRef.current(msRef.current, item.label); set(null); }, COMMIT_ANIM_MS);
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
        onOpenRef.current?.();
        set({ index: 1, committing: null }); // start on the first (most-used) tag
        arm(1);
        return;
      }
      e.preventDefault();
      if (active.committing) return; // frozen during the save flourish
      const dir = e.deltaY > 0 ? 1 : -1;
      const next = Math.min(items.length - 1, Math.max(0, active.index + dir));
      set({ index: next, committing: null });
      arm(next);
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
    };
  }, [containerRef]);

  if (!wheel) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-16 z-40 flex flex-col items-center gap-1">
      {SLOTS.map((off) => {
        const item = items[wheel.index + off];
        if (!item) return <div key={off} className="h-7" />; // empty slot past the ends
        const dist = Math.abs(off);
        const scale = dist === 0 ? 1 : dist === 1 ? 0.86 : 0.72;
        const opacity = dist === 0 ? 1 : dist === 1 ? 0.6 : 0.3;
        const center = off === 0;
        const committing = center && wheel.committing;
        const base = 'px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-150 shadow';
        const tone = !center
          ? (item.dismiss ? 'text-zinc-500' : 'bg-black/70 text-zinc-200')
          : committing
            ? 'bg-emerald-500 text-white font-semibold ring-1 ring-emerald-300/60'
            : item.dismiss
              ? 'bg-zinc-800/90 text-zinc-300 ring-1 ring-zinc-600'
              : 'bg-emerald-600 text-white font-medium ring-1 ring-emerald-400/50';
        return (
          <div key={off} style={{ transform: `scale(${scale})`, opacity }}
               className={`${base} ${tone} ${committing ? 'kn-bm-pop' : ''}`}>
            {item.dismiss ? '✕ Cancel' : committing ? '✓ Saved' : item.label}
          </div>
        );
      })}
    </div>
  );
}
