/**
 * Single source of truth for the height of the thumbnail row at the bottom of
 * the viewer — the reel film-strip (ViewerReel) and the panning minimap
 * (ViewportMinimap) both anchor to this height so they read as one row.
 *
 * If we add responsive scaling later (e.g. tying this to the kn-chrome-scaled
 * zoom on large displays), bumping this one number scales both pieces in step:
 *   • the reel tile's width = VIEWER_THUMB_H * REEL_TILE_ASPECT
 *   • the minimap's width   = VIEWER_THUMB_H * contentRatio   (per item)
 * The reel's tiles use a fixed 3:2 shape; the minimap is content-aspect-driven,
 * so for landscape items the minimap is wider than a reel tile and for
 * portrait items narrower — by design.
 */
export const VIEWER_THUMB_H = 96;

/** Reel tile shape (3:2). The minimap doesn't use this — its width tracks
 *  the active item's aspect. */
export const REEL_TILE_ASPECT = 1.5;
