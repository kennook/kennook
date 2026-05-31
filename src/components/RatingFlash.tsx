'use client';

import { likeFillColor } from '@/lib/like-colors';

const MAX = 5;

/**
 * Transient chip that surfaces an asset's current 0–5 rating when it
 * first opens. Pure presentation — visibility lifecycle (mount on item
 * change, fade-out via CSS) is handled by the caller via the `key` prop
 * keyed on the item uuid.
 *
 * Two visual variants:
 *   - count > 0  → full-color rose chip with N filled hearts.
 *   - count === 0 → muted "unrated" chip (zinc tones, dimmed via an
 *                   opacity wrapper) so the user sees "this is rateable
 *                   but has no rating yet" rather than nothing at all.
 *
 * The outer dimming wrapper composes with the kn-rating-flash keyframe's
 * own opacity transitions — peak visible opacity ends up at ~0.5 for the
 * unrated case while still fading in/out on its own schedule.
 */
export function RatingFlash({ count }: { count: number }) {
  const unrated = count === 0;
  // Filled hearts take the rating's intensity shade (pale@1 → vivid@5) so the
  // chip's color alone signals how strong the rating is.
  const ratingColor = likeFillColor(count);
  const heartStroke = unrated ? 'rgba(161,161,170,0.7)' : 'rgba(244,63,94,0.45)';
  return (
    <div className={unrated ? 'opacity-50' : ''}>
      <div
        role="status"
        aria-label={unrated ? 'Not yet rated' : `Rated ${count} out of ${MAX}`}
        className={`kn-rating-flash inline-flex items-center gap-2
                    bg-black/65 backdrop-blur rounded-full px-3.5 py-1.5
                    shadow-2xl pointer-events-none border
                    ${unrated ? 'border-zinc-700/50' : 'border-rose-700/40'}`}
      >
        <div className="flex gap-0.5">
          {Array.from({ length: MAX }).map((_, i) => {
            const filled = i < count;
            return (
              <svg
                key={i}
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill={filled ? (ratingColor ?? '#f43f5e') : 'transparent'}
                stroke={filled ? (ratingColor ?? '#f43f5e') : heartStroke}
                strokeWidth="1.6"
                strokeLinejoin="round"
              >
                <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
              </svg>
            );
          })}
        </div>
        <span
          className={`text-xs font-semibold tabular-nums ${unrated ? 'text-zinc-400' : ''}`}
          style={unrated ? undefined : { color: ratingColor ?? undefined }}
        >
          {count} / {MAX}
        </span>
      </div>
    </div>
  );
}
