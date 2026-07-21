'use client';

/**
 * Client hooks for hot corners. Both read the SAME cached tRPC query
 * (`hotCorners.get`) so there's one fetch shared across the engine + every
 * viewer/player that consults the fade predicate (react-query dedupes).
 */

import { useCallback, useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc-client';
import {
  cornerAt,
  DEFAULT_HOT_CORNERS,
  TRIGGER_ACTIONS,
  type Corner,
  type HotCornerAction,
  type HotCornerMap,
} from './hot-corner';

function useMap(): HotCornerMap {
  const q = trpc.hotCorners.get.useQuery(undefined, { staleTime: 60_000 });
  return q.data ?? DEFAULT_HOT_CORNERS;
}

/**
 * Returns a predicate `(clientX, clientY) => boolean` — true when the point sits
 * in a corner mapped to `hideControls`. The fullscreen viewer / video controls
 * call it to decide whether to IGNORE pointer movement for auto-hide (the
 * mouse-jiggler dead-corner, now on whichever corner(s) the user assigned).
 */
export function useHideCornerPredicate(): (x: number, y: number) => boolean {
  const map = useMap();
  return useCallback((x: number, y: number) => {
    const c = cornerAt(x, y);
    return c != null && map[c] === 'hideControls';
  }, [map]);
}

const COOLDOWN_MS = 1200;

/**
 * The global hot-corner engine — mount ONCE at the app root. Watches pointer
 * movement; when the cursor ENTERS a corner mapped to a trigger action
 * (screensaver), it calls `onAction(action)` — once per entry, with a cooldown,
 * and only after the cursor has left the corner before it can fire again. Hold
 * actions (hideControls) are handled by the predicate above, not here.
 */
export function useHotCornerEngine(onAction: (action: HotCornerAction) => void): void {
  const map = useMap();
  const mapRef = useRef(map); mapRef.current = map;
  const onActionRef = useRef(onAction); onActionRef.current = onAction;
  // The corner the cursor currently occupies (so we fire on ENTRY, not while
  // parked), plus the last time we fired (cooldown).
  const inCornerRef = useRef<Corner | null>(null);
  const lastFireRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return; // throttle to one check per frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        const corner = cornerAt(e.clientX, e.clientY);
        const prev = inCornerRef.current;
        inCornerRef.current = corner;
        if (!corner || corner === prev) return; // no change / left corner
        const action = mapRef.current[corner];
        if (!TRIGGER_ACTIONS.includes(action)) return;
        const now = Date.now();
        if (now - lastFireRef.current < COOLDOWN_MS) return;
        lastFireRef.current = now;
        onActionRef.current(action);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => { window.removeEventListener('pointermove', onMove); if (raf) cancelAnimationFrame(raf); };
  }, []);
}
