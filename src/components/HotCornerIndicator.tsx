'use client';

/**
 * A subtle on-screen cue for hot corners: when the cursor enters a corner that's
 * mapped to an action (anything but 'off'), a soft triangular glow lights up that
 * corner's active zone with a small label of what it does. Purely informational —
 * `pointer-events-none`, mounted once app-wide from HomeClient. Tracks the
 * pointer the same rAF-throttled way as the hot-corner engine, and reads the same
 * cached `hotCorners.get` query, so there's no extra fetch. The triangle is sized
 * to CORNER_PX, so what glows is exactly the live zone.
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

// Anchor the highlight to each corner.
const POS: Record<Corner, string> = {
  topLeft: 'top-0 left-0',
  topRight: 'top-0 right-0',
  bottomLeft: 'bottom-0 left-0',
  bottomRight: 'bottom-0 right-0',
};
// Per-corner right-triangle: `poly` = the two legs along the screen edges + the
// hypotenuse facing centre; `cx/cy` = the right-angle corner (glow origin);
// `hyp` = the hypotenuse line to outline. Coords in the 0–100 viewBox.
const TRI: Record<Corner, { poly: string; cx: number; cy: number; hyp: [number, number, number, number] }> = {
  topLeft:     { poly: '0,0 100,0 0,100',     cx: 0,   cy: 0,   hyp: [100, 0, 0, 100] },
  topRight:    { poly: '100,0 0,0 100,100',   cx: 100, cy: 0,   hyp: [0, 0, 100, 100] },
  bottomLeft:  { poly: '0,100 0,0 100,100',   cx: 0,   cy: 100, hyp: [0, 0, 100, 100] },
  bottomRight: { poly: '100,100 100,0 0,100', cx: 100, cy: 100, hyp: [100, 0, 0, 100] },
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
  const t = TRI[active];
  const label = LABEL[map[active]];

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]">
      <div className={`absolute ${POS[active]}`} style={{ width: CORNER_PX, height: CORNER_PX }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <defs>
            <radialGradient id="hc-grad" gradientUnits="userSpaceOnUse" cx={t.cx} cy={t.cy} r={100}>
              <stop offset="0%" stopColor="rgb(16,185,129)" stopOpacity="0.42" />
              <stop offset="55%" stopColor="rgb(16,185,129)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="rgb(16,185,129)" stopOpacity="0.05" />
            </radialGradient>
          </defs>
          {/* filled triangle = the corner */}
          <polygon points={t.poly} fill="url(#hc-grad)" />
          {/* crisp hypotenuse edge */}
          <line
            x1={t.hyp[0]} y1={t.hyp[1]} x2={t.hyp[2]} y2={t.hyp[3]}
            stroke="rgb(52,211,153)" strokeOpacity="0.5" strokeWidth="1.25"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
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
