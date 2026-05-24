/**
 * Thresholds for flagging sensitive content. Imported by both the server
 * filter (`hideSensitive` in buildFilterClauses) and the client UI
 * (badge on the card / viewer). Living in `lib/` so it's safe to import
 * from either side.
 *
 * Scores live raw on `media_items` so these numbers can move without
 * re-running `pnpm enrich:sensitive`. Tune as you see false positives:
 *   - bump NSFW up if too many beach/swimwear shots get flagged
 *   - bump VIOLENCE up if action/sports photos get flagged
 */
export const NSFW_THRESHOLD = 0.6;
export const VIOLENCE_THRESHOLD = 0.27;

export function isSensitive(nsfwScore: number, violenceScore: number): boolean {
  return nsfwScore >= NSFW_THRESHOLD || violenceScore >= VIOLENCE_THRESHOLD;
}
