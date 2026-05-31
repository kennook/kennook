'use client';

/**
 * Minimap pan control.
 *
 * Two modes:
 *   • Active (overflow exists): thumbnail with a movable rectangle
 *     marking the visible slice. Drag to pan. Double-click to recenter.
 *   • Inactive (no overflow — image fully visible): thumbnail at near-
 *     full opacity, no rectangle, no drag. Clicking it (if an
 *     `onActivate` handler is provided) lets the parent re-enable
 *     panning, typically by switching from contain to cover fit.
 *
 * Why this exists: the previous implementation hooked
 * mouse-drag-on-content for panning, which fought the video player's
 * volume slider, scrub bar, and play/pause toggle for the same gesture.
 * Isolating pan to a dedicated widget removes that conflict entirely.
 *
 * Coordinate math (all in display pixels unless stated):
 *
 *   contentDisplay{W,H} = content size after cover-fit scaling
 *   viewport{W,H}       = window viewport size
 *   maxX = (contentDisplayW - viewportW) / 2   — overflow on each side
 *   maxY = (contentDisplayH - viewportH) / 2
 *
 *   pan.x = +maxX  →  content shifted right → viewport sees LEFT edge
 *                  →  rect should be flush against minimap's LEFT side
 *   pan.x = 0      →  rect centered
 *   pan.x = -maxX  →  rect flush against minimap's RIGHT side
 */

import { useEffect, useRef, useState } from 'react';
import { VIEWER_THUMB_H } from '@/lib/viewer-thumb';

interface Props {
  /** Static image source — same URL used elsewhere as the preview. */
  src: string;
  /** Content natural width/height ratio (e.g. 1.5 for 3:2). */
  contentRatio: number;
  /** Cover-fit display size of the content in viewport pixels. */
  contentDisplayWidth: number;
  contentDisplayHeight: number;
  /** Window viewport size. */
  viewportWidth: number;
  viewportHeight: number;
  /** Current pan offset in display pixels (cover-pixel units). */
  pan: { x: number; y: number };
  /** Max pan per axis: how far the content can shift before clipping
   *  (cover-pixel units, matches `pan`). */
  maxX: number;
  maxY: number;
  /** Zoom multiplier applied to the visible content. Defaults to 1.
   *  When > 1, the viewport shows a smaller fraction of the content,
   *  so the rect shrinks proportionally; pan limits stay in the same
   *  cover-pixel units. */
  zoom?: number;
  /** Called continuously during drag. */
  onPanChange: (next: { x: number; y: number }) => void;
  /** Called once on drag end with the final position (for persistence). */
  onPanCommit?: (final: { x: number; y: number }) => void;
  /**
   * Optional click handler for the INACTIVE state (no overflow). When
   * provided, the inactive minimap becomes clickable — typical use is
   * to flip the viewer to cover fit so panning becomes available.
   * Ignored in the active state.
   */
  onActivate?: () => void;
  /** Extra class names for positioning. */
  className?: string;
}

// Drag interaction: clicks outside the rect re-center it (and start a
// drag from there). The threshold avoids treating a tiny mouse twitch
// during a click as a jump.
const CLICK_RECENTER = true;

export function ViewportMinimap({
  src,
  contentRatio,
  contentDisplayWidth,
  contentDisplayHeight,
  viewportWidth,
  viewportHeight,
  pan,
  maxX,
  maxY,
  onPanChange,
  onPanCommit,
  onActivate,
  zoom = 1,
  className,
}: Props) {
  // Hooks at top — must be called unconditionally in the same order on
  // every render to satisfy the Rules of Hooks.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => setDragging(false), []);

  if (!Number.isFinite(contentRatio) || contentRatio <= 0) return null;

  // Height is shared with the reel film-strip via VIEWER_THUMB_H so the
  // minimap and the tiles sit at the same height and share a baseline. Width
  // tracks the active item's aspect — landscape items end up wider than a
  // reel tile and portrait items narrower, which is the correct encoding for
  // a "this is the item you're looking at" widget.
  const thumbH = VIEWER_THUMB_H;
  const thumbW = VIEWER_THUMB_H * contentRatio;
  const hasPan = maxX > 0 || maxY > 0;

  // ── Inactive state ──────────────────────────────────────────────────
  //
  // No overflow → no pan possible. Show the full image at thumb size,
  // no rect, no drag affordance. If `onActivate` is provided, the whole
  // tile becomes clickable as a hint that the user can re-enable pan.
  if (!hasPan) {
    return (
      <div
        onClick={onActivate}
        title={onActivate
          ? 'Full image visible · click to crop (cover)'
          : 'Full image visible'}
        className={`relative rounded overflow-hidden bg-black/60 ring-1 ring-zinc-800
                    shadow-lg select-none
                    ${onActivate ? 'cursor-pointer hover:ring-zinc-600' : ''}
                    ${className ?? ''}`}
        style={{ width: thumbW, height: thumbH }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-contain opacity-90
                     pointer-events-none"
        />
      </div>
    );
  }

  // ── Active state ────────────────────────────────────────────────────
  //
  // Two scales because pan and viewport are measured against different
  // reference frames:
  //   • posScale (thumb/cover): converts pan (in cover-pixel units) to
  //     thumb pixels — pan's reference is the cover-fit overflow, which
  //     doesn't change with zoom.
  //   • sizeScale (thumb/(cover·zoom)): converts the viewport size to
  //     the rect — the viewport's reference IS zoom-dependent because
  //     at higher zoom the viewport shows proportionally less content.

  const posScale  = thumbW / contentDisplayWidth;
  const sizeScale = posScale / zoom;

  const rectW = Math.min(thumbW, viewportWidth  * sizeScale);
  const rectH = Math.min(thumbH, viewportHeight * sizeScale);

  // Rect-position clamp range = intersection of thumb-edge bounds AND
  // the rect positions corresponding to ±maxX/±maxY pan (so the user
  // can't drag the rect past where the actual pan can go).
  const minRectLeft = Math.max(0, (thumbW - rectW) / 2 - maxX * posScale);
  const maxRectLeft = Math.min(thumbW - rectW, (thumbW - rectW) / 2 + maxX * posScale);
  const minRectTop  = Math.max(0, (thumbH - rectH) / 2 - maxY * posScale);
  const maxRectTop  = Math.min(thumbH - rectH, (thumbH - rectH) / 2 + maxY * posScale);

  const rectLeft = clamp((thumbW - rectW) / 2 - pan.x * posScale, minRectLeft, maxRectLeft);
  const rectTop  = clamp((thumbH - rectH) / 2 - pan.y * posScale, minRectTop,  maxRectTop);

  function panFromRectPosition(left: number, top: number) {
    const newLeft = clamp(left, minRectLeft, maxRectLeft);
    const newTop  = clamp(top,  minRectTop,  maxRectTop);
    return {
      x: ((thumbW - rectW) / 2 - newLeft) / posScale,
      y: ((thumbH - rectH) / 2 - newTop)  / posScale,
    };
  }

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const host = rootRef.current;
    if (!host) return;

    const rect = host.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startThumbX = startX - rect.left;
    const startThumbY = startY - rect.top;
    const startedInRect =
      startThumbX >= rectLeft && startThumbX <= rectLeft + rectW &&
      startThumbY >= rectTop  && startThumbY <= rectTop  + rectH;

    // Initial pointer offset is "where in the rect the pointer is."
    // For outside-rect starts this is meaningless until the first drag
    // tick recenters the rect under the pointer, at which point we
    // overwrite it. Keep mutable.
    let pointerOffsetX = startThumbX - rectLeft;
    let pointerOffsetY = startThumbY - rectTop;
    let hasDragged = false;
    let lastPan = { x: pan.x, y: pan.y };
    const DRAG_THRESHOLD = 4; // px — distinguishes a click from a drag

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!hasDragged && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        hasDragged = true;
        setDragging(true);
        // First time crossing the threshold from an outside-rect start
        // → jump-recenter the rect to where the user pressed down,
        // then continue dragging from there. The recenter happens only
        // on drag (not on bare click) so click-to-activate still works.
        if (!startedInRect && CLICK_RECENTER) {
          const newRectLeft = startThumbX - rectW / 2;
          const newRectTop  = startThumbY - rectH / 2;
          const recenteredPan = panFromRectPosition(newRectLeft, newRectTop);
          lastPan = recenteredPan;
          onPanChange(recenteredPan);
          pointerOffsetX = rectW / 2;
          pointerOffsetY = rectH / 2;
        }
      }
      if (hasDragged) {
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const next = panFromRectPosition(
          px - pointerOffsetX,
          py - pointerOffsetY,
        );
        lastPan = next;
        onPanChange(next);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (hasDragged) {
        setDragging(false);
        onPanCommit?.(lastPan);
      } else if (onActivate) {
        // Pure click → fire the activate handler (typically toggles
        // the parent's fit mode).
        onActivate();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  return (
    <div
      ref={rootRef}
      onPointerDown={startDrag}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onPanChange({ x: 0, y: 0 });
        onPanCommit?.({ x: 0, y: 0 });
      }}
      title={onActivate
        ? 'Drag to pan · click to fit · double-click to recenter'
        : 'Drag to pan · double-click to recenter'}
      className={`relative rounded overflow-hidden bg-black/60 ring-1 ring-zinc-800
                  shadow-lg select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}
                  ${className ?? ''}`}
      style={{ width: thumbW, height: thumbH, touchAction: 'none' }}
    >
      {/* Full content thumbnail. Dimmed everywhere; the rect overlay
          lightens the visible region to draw the eye. */}
      <img
        src={src}
        alt=""
        draggable={false}
        className="absolute inset-0 w-full h-full object-contain opacity-50
                   pointer-events-none"
      />
      {/* The visible-region rect. Bright outline + a slight white
          highlight on top so it stands out against the dimmed thumb. */}
      <div
        className="absolute border border-emerald-400 bg-emerald-400/10
                   pointer-events-none"
        style={{
          left: rectLeft,
          top: rectTop,
          width: rectW,
          height: rectH,
        }}
      />
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, v));
}
