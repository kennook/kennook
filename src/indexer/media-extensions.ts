/**
 * Supported media file extensions, shared by the indexer and the upload route.
 *
 * Kept in its own module so callers (e.g. the admin upload route) can validate
 * file types without importing `src/indexer/index.ts`, whose bottom-level
 * `main()` runs on import.
 */

// Only formats a browser can natively DISPLAY / PLAY. KenNook shows all media
// in the browser, so anything it can't render — TIFF/RAW images, or MKV/AVI/WMV
// videos — is intentionally NOT indexed: there'd be nothing to view. (sharp/
// ffmpeg could still make a thumbnail, but the fullscreen original wouldn't
// open, so it's dead weight.)
export const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif',
]);

export const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.ogv',
]);

/** Classify a file extension as photo/video, or null if unsupported. */
export function kindForExt(ext: string): 'photo' | 'video' | null {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e)) return 'photo';
  if (VIDEO_EXTS.has(e)) return 'video';
  return null;
}
