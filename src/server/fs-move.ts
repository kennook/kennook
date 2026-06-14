import fs from 'node:fs';
import path from 'node:path';

/**
 * A non-colliding variant of `fullPath`: if it already exists, append " (n)"
 * before the extension until a free name is found.
 */
export function uniquePath(fullPath: string): string {
  if (!fs.existsSync(fullPath)) return fullPath;
  const dir = path.dirname(fullPath);
  const ext = path.extname(fullPath);
  const stem = path.basename(fullPath, ext);
  let n = 1;
  let candidate: string;
  do {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  } while (fs.existsSync(candidate));
  return candidate;
}

/**
 * Move a file. `fs.renameSync` is atomic on the same volume; across volumes it
 * throws EXDEV, so fall back to copy + unlink.
 */
export function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}
