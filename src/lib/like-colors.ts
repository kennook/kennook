/**
 * Like-intensity color ramp. The heart shade deepens with the rating so the
 * count is readable at a glance: pale red at 1 → vivid red at 5.
 *
 * Single source of truth — MediaCard, MediaViewer, and the FilterSidebar
 * likes slider all pull from here so the visual language stays consistent.
 *
 * Theme note: the app currently ships a fixed DARK theme. The DARK ramp is
 * tuned to read on the zinc-950 surface (pale = soft/light, vivid = saturated
 * and punchy). When a light theme lands, add a LIGHT ramp and select on the
 * active scheme — this function is the only place that needs to change.
 */

// 1 → 5. Pale rose → vivid deep red. Index 2 (#f43f5e) is the original
// single-shade rose, kept as the midpoint for visual continuity.
const DARK_RAMP = [
  '#f9a8b6', // 1 — pale
  '#f5798f', // 2
  '#f43f5e', // 3 — rose-500 (former default)
  '#ec1e49', // 4
  '#e60033', // 5 — vivid
] as const;

/** Fill color for a given like count, or null when unrated (count ≤ 0). */
export function likeFillColor(count: number): string | null {
  if (!count || count <= 0) return null;
  const i = Math.min(5, Math.max(1, Math.round(count))) - 1;
  return DARK_RAMP[i];
}
