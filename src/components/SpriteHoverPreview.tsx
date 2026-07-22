'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

// The preview skims the whole clip in a time PROPORTIONAL to its length, so a
// short clip gets a brief look and a long one a longer (but bounded) skim —
// instead of a flat per-frame speed that flickers short clips and drags long
// ones. Per-frame dwell is then derived from the frame count and clamped, so the
// motion stays smooth whether the sheet has 8 frames or 150.
const PREVIEW_FRACTION = 0.12;   // skim ≈ 12% of real time…
const MIN_LOOP_MS = 3500;        // …but at least this long,
const MAX_LOOP_MS = 14000;       // …and at most this long.
const MIN_FRAME_MS = 140;        // never a flicker,
const MAX_FRAME_MS = 500;        // never a painful slideshow.

/** Per-frame dwell for a sprite, from its manifest (intervalMs × count ≈ the
 *  video's length). */
function frameMsFor(intervalMs: number, count: number): number {
  const videoMs = Math.max(1, intervalMs * count);
  const loopMs = Math.min(MAX_LOOP_MS, Math.max(MIN_LOOP_MS, videoMs * PREVIEW_FRACTION));
  return Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, loopMs / Math.max(1, count)));
}

/**
 * Fills a video tile with a fast traversal of its scrub sprite sheet — a silent,
 * cheap "video preview" on hover. Reuses the exact sprite geometry + frame math
 * the viewer's scrubber uses (media.scrubSprite → { url, cols, rows, count }).
 *
 * Cost is kept light: mounted ONLY after a dwell (parent gates it), so the sprite
 * is fetched lazily for the one hovered tile; the JPEG is preloaded and the frame
 * div only renders once it's decoded (no black flash over the thumbnail); returns
 * null when the video has no sprite yet (graceful fallback to the static thumb).
 */
export function SpriteHoverPreview({ uuid, librarySlug }: { uuid: string; librarySlug: string }) {
  const q = trpc.media.scrubSprite.useQuery(
    { uuid, librarySlug },
    { staleTime: 60 * 60 * 1000 }, // static once generated — cache long
  );
  const sprite = q.data;

  const [loaded, setLoaded] = useState(false);
  const [idx, setIdx] = useState(0);

  // Preload the sprite JPEG so we only reveal frames once it's decoded.
  useEffect(() => {
    setLoaded(false);
    if (!sprite?.url) return;
    const img = new Image();
    img.onload = () => setLoaded(true);
    img.src = sprite.url;
    return () => { img.onload = null; };
  }, [sprite?.url]);

  // Cycle frames while mounted (i.e. while hovering), at a length-aware cadence.
  useEffect(() => {
    if (!sprite || !loaded || sprite.count <= 1) return;
    setIdx(0);
    const frameMs = frameMsFor(sprite.intervalMs, sprite.count);
    const t = setInterval(() => setIdx((i) => (i + 1) % sprite.count), frameMs);
    return () => clearInterval(t);
  }, [sprite, loaded]);

  if (!sprite || !loaded) return null;

  const col = idx % sprite.cols;
  const row = Math.floor(idx / sprite.cols);
  // Percentage sprite technique: scale the sheet so each tile == the container,
  // then position by the fractional cell. Handles any tile size / card size.
  const bgX = sprite.cols > 1 ? (col / (sprite.cols - 1)) * 100 : 0;
  const bgY = sprite.rows > 1 ? (row / (sprite.rows - 1)) * 100 : 0;

  return (
    <div
      className="absolute inset-0 pointer-events-none bg-black"
      style={{
        backgroundImage: `url(${sprite.url})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${sprite.cols * 100}% ${sprite.rows * 100}%`,
        backgroundPosition: `${bgX}% ${bgY}%`,
      }}
      aria-hidden
    />
  );
}
