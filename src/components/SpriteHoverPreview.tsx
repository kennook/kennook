'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

// Frame cadence for the hover traversal — a relaxed step so the preview reads as
// a slow skim through the clip rather than a fast flicker.
const FRAME_MS = 220;

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

  // Cycle frames while mounted (i.e. while hovering).
  useEffect(() => {
    if (!sprite || !loaded || sprite.count <= 1) return;
    setIdx(0);
    const t = setInterval(() => setIdx((i) => (i + 1) % sprite.count), FRAME_MS);
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
