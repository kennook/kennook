/**
 * Height of the panning minimap (ViewportMinimap) at the bottom-right of the
 * viewer — its width is `VIEWER_THUMB_H * contentRatio` per item.
 *
 * NOTE: the coming-up reel (ViewerReel) used to anchor to this too, back when it
 * was a horizontal film-strip across the bottom. It's now a vertical column down
 * the left edge with its own (smaller) tile size, so it no longer references
 * this — only the minimap does.
 */
export const VIEWER_THUMB_H = 96;

/** Tile shape (3:2) shared by the reel tiles. The minimap doesn't use this —
 *  its width tracks the active item's aspect. */
export const REEL_TILE_ASPECT = 1.5;
