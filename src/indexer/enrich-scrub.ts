// Scrub-preview sprite sheets. For every video with scrub_status='pending':
//
//   1. compute a grid — sample a frame every N seconds, capped to ~150 tiles
//   2. ffmpeg renders ONE montage JPEG (fit+pad tiles) in a single pass
//   3. save to data/<library>/scrub-sprites/<uuid>/sprite.jpg
//   4. store the grid manifest in media_items.scrub_meta (JSON)
//
// Resumable: scrub_status flips to 'done' / 'failed' per row, so re-runs only
// pick up un-processed videos.
//
//   pnpm enrich:scrub                  # personal library
//   pnpm enrich:scrub --library work   # named library
//   pnpm enrich:scrub --reset          # re-render every video
//   pnpm enrich:scrub --limit 5        # cap for testing

import fs from 'node:fs';
import path from 'node:path';
import { getRawSqlite } from '@/db/client';
import { DEFAULT_LIBRARY_SLUG, resolveLibrary, libraryRoot } from '@/server/libraries';
import { parseRootPath, resolveMediaPath } from '@/server/storage';
import { generateSpriteSheet, probeVideo, ensureFfmpegAvailable } from './ffmpeg';
import { emitProgress } from './progress';
import { installGracefulStop, shouldStop } from './graceful-stop';
import { pace, getThrottle, throttleTag, reportThrottleChange } from '@/ai/throttle';

// A scrub track only needs ~1 tile every few seconds; cap the grid so long
// videos don't blow up the sprite. 150 × 160px tiles is a small JPEG.
const MAX_TILES = 150;
const TILE_W = 160;
const COLS = 10;

interface Args { librarySlug: string; reset: boolean; limit: number | null; }

function parseArgs(argv: string[]): Args {
  let librarySlug = DEFAULT_LIBRARY_SLUG;
  let reset = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library' || a === '-w') { const v = argv[++i]; if (v) librarySlug = v; }
    else if (a.startsWith('--library=')) librarySlug = a.split('=')[1];
    else if (a === '--reset') reset = true;
    else if (a === '--limit') { const v = argv[++i]; if (v) limit = parseInt(v, 10); }
    else if (a.startsWith('--limit=')) limit = parseInt(a.split('=')[1], 10);
  }
  return { librarySlug, reset, limit };
}

interface PendingRow {
  id: number;
  uuid: string;
  filename: string;
  rel_path: string;
  storage_config: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
}

function spriteDirFor(slug: string, uuid: string): string {
  return path.join(libraryRoot(slug), 'scrub-sprites', uuid);
}

/** Nearest even integer ≥ 2 — keeps scalers happy. */
function even(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 ? r + 1 : r;
}

async function main() {
  installGracefulStop();
  const args = parseArgs(process.argv.slice(2));
  const library = resolveLibrary(args.librarySlug);
  const sqlite = getRawSqlite(library.slug);

  const ffmpegOk = await ensureFfmpegAvailable();
  if (!ffmpegOk) {
    console.error('ffmpeg not available on PATH — install via `brew install ffmpeg`.');
    process.exit(2);
  }

  if (args.reset) {
    sqlite.exec(`UPDATE media_items SET scrub_status = 'pending' WHERE kind = 'video'`);
    console.log('Reset scrub_status for all videos.');
  }

  const limitClause = args.limit ? `LIMIT ${args.limit}` : '';
  const pending = sqlite.prepare(`
    SELECT m.id, m.uuid, m.filename, m.path AS rel_path, sl.config AS storage_config,
           m.duration_ms, m.width, m.height
    FROM media_items m
    JOIN storage_locations sl ON sl.id = m.storage_location_id
    WHERE m.kind = 'video'
      AND m.scrub_status = 'pending'
      AND m.deleted_at IS NULL
    ORDER BY m.id
    ${limitClause}
  `).all() as unknown as PendingRow[];

  console.log(
    `Scrub sprites in library "${library.name}" (${library.slug}): ` +
    `${pending.length} video(s) to process.`,
  );
  if (pending.length === 0) return;

  const markDone = sqlite.prepare(
    `UPDATE media_items SET scrub_status = 'done', scrub_meta = ?, updated_at = ? WHERE id = ?`,
  );
  const markFailed = sqlite.prepare(
    `UPDATE media_items SET scrub_status = 'failed', updated_at = ? WHERE id = ?`,
  );

  let done = 0;
  let failed = 0;
  const start = Date.now();

  for (const row of pending) {
    if (shouldStop()) { console.log('\n[paused] stopping after current video — progress saved.'); break; }
    emitProgress({
      step: 'Enrich: scrub',
      current: done + failed,
      total: pending.length,
      label: 'render sprite sheet',
      currentItem: row.uuid,
      currentItemKind: 'uuid',
      currentItemLibrary: library.slug,
    });

    const abs = resolveMediaPath(parseRootPath(row.storage_config), row.rel_path);
    if (!fs.existsSync(abs)) {
      failed++;
      markFailed.run(Date.now(), row.id);
      process.stdout.write(`  ✗ ${row.filename} — file missing\n`);
      continue;
    }

    const itemStart = Date.now();
    try {
      // Duration + dims: prefer what indexing already stored, else probe.
      let durationMs = row.duration_ms;
      let width = row.width;
      let height = row.height;
      if (!durationMs || !width || !height) {
        const meta = await probeVideo(abs);
        durationMs = durationMs ?? meta.durationMs;
        width = width ?? meta.width;
        height = height ?? meta.height;
      }
      if (!durationMs || durationMs <= 0) throw new Error('unknown duration');

      const durSec = durationMs / 1000;
      const intervalSec = Math.max(1, Math.ceil(durSec / MAX_TILES));
      const count = Math.max(1, Math.ceil(durSec / intervalSec));
      const cols = Math.min(count, COLS);
      const rows = Math.ceil(count / cols);
      const tileW = TILE_W;
      const tileH = width && height
        ? even(Math.min(400, Math.max(60, (TILE_W * height) / width)))
        : 90;

      const dir = spriteDirFor(library.slug, row.uuid);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const outPath = path.join(dir, 'sprite.jpg');

      // Cap ffmpeg's threads per the current processor-load throttle (read live
      // each item, so a UI change applies to the next sprite).
      await generateSpriteSheet(abs, outPath, { intervalSec, tileW, tileH, cols, rows, threads: getThrottle().threads });

      const meta = JSON.stringify({ intervalMs: intervalSec * 1000, cols, rows, tileW, tileH, count });
      markDone.run(meta, Date.now(), row.id);
      done++;
      const elapsed = ((Date.now() - itemStart) / 1000).toFixed(1);
      process.stdout.write(`  ✓ ${row.filename} — ${count} tiles (${cols}×${rows}, every ${intervalSec}s) (${elapsed}s · ${throttleTag()})\n`);
    } catch (err) {
      failed++;
      markFailed.run(Date.now(), row.id);
      process.stdout.write(`  ✗ ${row.filename} — ${(err as Error).message}\n`);
    }

    // Duty-cycle pause + surface any load change (both read the live setting).
    await pace(Date.now() - itemStart);
    reportThrottleChange();
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone: ${done} sprite(s), ${failed} failed, in ${secs}s.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
