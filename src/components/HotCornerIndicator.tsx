'use client';

/**
 * A subtle on-screen cue for hot corners: when the cursor enters a corner that's
 * mapped to an action (anything but 'off'), a soft glow lights up that corner's
 * active zone with a small label of what it does. Purely informational —
 * `pointer-events-none`, mounted once app-wide from HomeClient. Tracks the
 * pointer the same rAF-throttled way as the hot-corner engine, and reads the same
 * cached `hotCorners.get` query, so there's no extra fetch.
 */

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import {
  cornerAt,
  CORNER_PX,
  DEFAULT_HOT_CORNERS,
  type Corner,
  type HotCornerAction,
} from '@/lib/hot-corner';

// Anchor the highlight square to each corner.
const POS: Record<Corner, string> = {
  topLeft: 'top-0 left-0',
  topRight: 'top-0 right-0',
  bottomLeft: 'bottom-0 left-0',
  bottomRight: 'bottom-0 right-0',
};
// Origin for the radial glow so it emanates FROM the corner.
const GRAD_AT: Record<Corner, string> = {
  topLeft: 'top left',
  topRight: 'top right',
  bottomLeft: 'bottom left',
  bottomRight: 'bottom right',
};
// Which two inner edges to outline (the ones facing screen centre).
const INNER_EDGE: Record<Corner, string> = {
  topLeft: 'border-r border-b rounded-br-lg',
  topRight: 'border-l border-b rounded-bl-lg',
  bottomLeft: 'border-r border-t rounded-tr-lg',
  bottomRight: 'border-l border-t rounded-tl-lg',
};
// Pin the label to the corner; it extends toward screen centre.
const LABEL_POS: Record<Corner, string> = {
  topLeft: 'top-1.5 left-1.5',
  topRight: 'top-1.5 right-1.5',
  bottomLeft: 'bottom-1.5 left-1.5',
  bottomRight: 'bottom-1.5 right-1.5',
};

const LABEL: Partial<Record<HotCornerAction, string>> = {
  hideControls: 'Controls fade here',
  screensaver: 'Start screensaver',
};

export function HotCornerIndicator() {
  const map = trpc.hotCorners.get.useQuery(undefined, { staleTime: 60_000 }).data ?? DEFAULT_HOT_CORNERS;
  const mapRef = useRef(map);
  mapRef.current = map;
  const [active, setActive] = useState<Corner | null>(null);

  useEffect(() => {
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return; // one check per frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        const c = cornerAt(e.clientX, e.clientY);
        const next = c != null && mapRef.current[c] !== 'off' ? c : null;
        setActive((prev) => (prev === next ? prev : next));
      });
    };
    const clear = () => setActive(null);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('blur', clear);
    document.addEventListener('mouseleave', clear);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('blur', clear);
      document.removeEventListener('mouseleave', clear);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  if (!active) return null;
  const label = LABEL[map[active]];

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]">
      <div className={`absolute ${POS[active]}`} style={{ width: CORNER_PX, height: CORNER_PX }}>
        {/* soft glow from the corner */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(circle at ${GRAD_AT[active]}, rgba(16,185,129,0.34) 0%, rgba(16,185,129,0.12) 45%, transparent 72%)`,
          }}
        />
        {/* delineate the active zone on its inner edges */}
        <div className={`absolute inset-0 border-emerald-400/45 ${INNER_EDGE[active]}`} />
        {label && (
          <div
            className={`absolute ${LABEL_POS[active]} inline-flex items-center gap-1 whitespace-nowrap
                        rounded-md bg-zinc-950/85 px-2 py-1 text-[11px] font-medium text-emerald-200
                        ring-1 ring-emerald-800/60 shadow-lg`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {label}
          </div>
        )}
      </div>
    </div>
  );
}
