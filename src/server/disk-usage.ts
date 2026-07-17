import fs from 'node:fs';

/**
 * Filesystem capacity for the volume a path lives on — the numbers behind the
 * Disk-Utility-style capacity bar in the storage admin. Reports the WHOLE
 * filesystem (like Disk Utility's "shared by N volumes"), not just this
 * library's footprint; the library's own usage is the sum of indexed
 * `size_bytes`, tracked separately.
 */
export interface DiskUsage {
  /** Total size of the filesystem, in bytes. */
  capacityBytes: number;
  /** Free space available to this user, in bytes. */
  freeBytes: number;
}

/**
 * Best-effort `statfs` for `rootPath`. Returns null when the path is missing /
 * unreadable (offline drive) or `statfs` isn't available — callers treat null
 * as "capacity unknown" and just hide the bar.
 */
export function diskUsageFor(rootPath: string): DiskUsage | null {
  try {
    const st = fs.statfsSync(rootPath);
    const capacityBytes = st.blocks * st.bsize;
    // `bavail` = blocks free for unprivileged users (what the OS reports as
    // "Available"), which matches Finder/Disk Utility's free-space figure
    // better than `bfree` (which includes root-reserved blocks).
    const freeBytes = st.bavail * st.bsize;
    if (!Number.isFinite(capacityBytes) || capacityBytes <= 0) return null;
    return { capacityBytes, freeBytes };
  } catch {
    return null;
  }
}
