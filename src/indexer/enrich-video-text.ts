// Multi-frame video OCR. For every video with video_text_status='pending':
//
//   1. detect scene-change timestamps via ffmpeg
//   2. extract a frame at each timestamp
//   3. run Florence-2 OCR on the frame
//   4. dedupe consecutive identical text (extend t_end_ms instead of
//      emitting a fresh occurrence)
//   5. persist as media_text_occurrences (source='ocr', timestamped)
//   6. save a 256px JPEG of each kept frame to
//      data/<library>/text-frames/<uuid>/<t_ms>.jpg so search results in
//      Phase 4 can render "match at 0:45" tiles without re-extracting.
//
// Resumable: video_text_status flips to 'done' / 'failed' per row, so re-runs
// only pick up un-processed videos.
//
//   pnpm enrich:video-text                  # personal library
//   pnpm enrich:video-text --library work   # named library
//   pnpm enrich:video-text --reset          # re-process every video
//   pnpm enrich:video-text --limit 5        # cap for testing
//   pnpm enrich:video-text --threshold 0.4  # tighter scene detection

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getRawSqlite } from '@/db/client';
import {
  DEFAULT_LIBRARY_SLUG,
  resolveLibrary,
  libraryRoot,
} from '@/server/libraries';
import { parseRootPath, resolveMediaPath } from '@/server/storage';
import {
  detectSceneChanges,
  extractFrame,
  ensureFfmpegAvailable,
} from './ffmpeg';
import { extractOcr } from '@/ai/vlm';
import {
  replaceOccurrences,
  type OccurrenceInput,
} from '@/server/text-occurrences';
import { emitProgress } from './progress';
import { installGracefulStop, shouldStop } from './graceful-stop';

interface Args {
  librarySlug: string;
  reset: boolean;
  limit: number | null;
  threshold: number;
  maxFrames: number;
}

function parseArgs(argv: string[]): Args {
  let librarySlug = DEFAULT_LIBRARY_SLUG;
  let reset = false;
  let limit: number | null = null;
  let threshold = 0.3;
  let maxFrames = 500;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library' || a === '-w') {
      const v = argv[++i]; if (v) librarySlug = v;
    } else if (a.startsWith('--library=')) {
      librarySlug = a.split('=')[1];
    } else if (a === '--reset') {
      reset = true;
    } else if (a === '--limit') {
      const v = argv[++i]; if (v) limit = parseInt(v, 10);
    } else if (a.startsWith('--limit=')) {
      limit = parseInt(a.split('=')[1], 10);
    } else if (a === '--threshold') {
      const v = argv[++i]; if (v) threshold = parseFloat(v);
    } else if (a.startsWith('--threshold=')) {
      threshold = parseFloat(a.split('=')[1]);
    } else if (a === '--max-frames') {
      const v = argv[++i]; if (v) maxFrames = parseInt(v, 10);
    } else if (a.startsWith('--max-frames=')) {
      maxFrames = parseInt(a.split('=')[1], 10);
    }
  }
  return { librarySlug, reset, limit, threshold, maxFrames };
}

interface PendingRow {
  id: number;
  uuid: string;
  filename: string;
  rel_path: string;
  storage_config: string;
}

/** Where per-item OCR frame thumbs live. Phase 4 serves these directly. */
function frameDirFor(slug: string, uuid: string): string {
  return path.join(libraryRoot(slug), 'text-frames', uuid);
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
    sqlite.exec(`UPDATE media_items SET video_text_status = 'pending' WHERE kind = 'video'`);
    console.log('Reset video_text_status for all videos.');
  }

  const limitClause = args.limit ? `LIMIT ${args.limit}` : '';
  const pending = sqlite.prepare(`
    SELECT m.id, m.uuid, m.filename, m.path AS rel_path, sl.config AS storage_config
    FROM media_items m
    JOIN storage_locations sl ON sl.id = m.storage_location_id
    WHERE m.kind = 'video'
      AND m.video_text_status = 'pending'
      AND m.deleted_at IS NULL
    ORDER BY m.id
    ${limitClause}
  `).all() as unknown as PendingRow[];

  console.log(
    `Video OCR in library "${library.name}" (${library.slug}): ` +
    `${pending.length} video(s) to process.`,
  );
  if (pending.length === 0) return;

  const markDone = sqlite.prepare(
    `UPDATE media_items SET video_text_status = 'done', updated_at = ? WHERE id = ?`,
  );
  const markFailed = sqlite.prepare(
    `UPDATE media_items SET video_text_status = 'failed', updated_at = ? WHERE id = ?`,
  );

  let done = 0;
  let failed = 0;
  let occurrencesTotal = 0;
  let framesTotal = 0;
  const start = Date.now();

  for (const row of pending) {
    if (shouldStop()) { console.log('\n[paused] stopping after current video — progress saved.'); break; }
    emitProgress({
      step: 'Enrich: video-text',
      current: done + failed,
      total: pending.length,
      label: 'scene detect + OCR per frame',
      currentItem: row.uuid,
      currentItemKind: 'uuid',
      currentItemLibrary: library.slug,
    });

    const abs = resolveMediaPath(parseRootPath(row.storage_config), row.rel_path);
    if (!fs.existsSync(abs)) {
      failed++;
      markFailed.run(Date.now(), row.id);
      process.stdout.write(`\n✗ ${row.filename}: file missing on disk\n`);
      continue;
    }

    const tStart = Date.now();
    try {
      const result = await runAndPersist(args, row, abs, sqlite, {
        videoIndex: done + failed,
        videoTotal: pending.length,
        librarySlug: library.slug,
      });
      occurrencesTotal += result.kept;
      framesTotal += result.framesProcessed;
      markDone.run(Date.now(), row.id);
      done++;
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      process.stdout.write(
        `\n✓ ${row.filename}: ${result.kept} occurrence(s) from ${result.framesProcessed} frame(s) (${elapsed}s)\n`,
      );
    } catch (e) {
      failed++;
      markFailed.run(Date.now(), row.id);
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`\n✗ ${row.filename}: ${msg}\n`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  emitProgress({
    step: 'Enrich: video-text',
    current: pending.length,
    total: pending.length,
    label: `done — ${done} ok, ${failed} failed, ${occurrencesTotal} occurrences across ${framesTotal} frames`,
  });
  console.log(
    `\nDone. ${done} ok, ${failed} failed, ${occurrencesTotal} occurrence(s) ` +
    `across ${framesTotal} frame(s) in ${elapsed}s.`,
  );
}

/**
 * Variant of processVideo that ALSO writes the occurrences to the DB.
 * Splitting these felt awkward — kept as one function so the work-loop
 * stays linear and we don't have to thread a return type carrying frame
 * thumbnails out of the OCR pass.
 */
async function runAndPersist(
  args: Args,
  row: PendingRow,
  abs: string,
  sqlite: ReturnType<typeof getRawSqlite>,
  ctx: { videoIndex: number; videoTotal: number; librarySlug: string },
): Promise<{ kept: number; framesProcessed: number }> {
  const stops = await detectSceneChanges(abs, {
    threshold: args.threshold,
    coalesceWithinSec: 2,
    maxFrames: args.maxFrames,
  });

  const occurrences: OccurrenceInput[] = [];
  let last: OccurrenceInput | null = null;

  const frameDir = frameDirFor(args.librarySlug, row.uuid);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  let framesProcessed = 0;
  for (const tMs of stops) {
    let buf: Buffer;
    try {
      buf = await extractFrame(abs, tMs / 1000);
    } catch {
      continue;
    }
    framesProcessed++;

    const tmp = path.join(frameDir, `__tmp.jpg`);
    fs.writeFileSync(tmp, buf);
    let text = '';
    try { text = (await extractOcr(tmp)).trim(); } catch { /* skip frame */ }
    fs.rmSync(tmp, { force: true });

    if (!text) continue;

    if (last && last.text === text) {
      last.tEndMs = tMs;
      continue;
    }

    const thumbPath = path.join(frameDir, `${tMs}.jpg`);
    try {
      await sharp(buf)
        .rotate()
        .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(thumbPath);
    } catch { /* thumb best-effort */ }

    // Live text: surface what was just read off this frame, with its
    // timestamp, so the user sees recognition happening frame by frame.
    const mm = Math.floor(tMs / 60000);
    const ss = Math.floor((tMs % 60000) / 1000).toString().padStart(2, '0');
    emitProgress({
      step: 'Enrich: video-text',
      current: ctx.videoIndex,
      total: ctx.videoTotal,
      label: `OCR @ ${mm}:${ss}`,
      currentItem: row.uuid,
      currentItemKind: 'uuid',
      currentItemLibrary: ctx.librarySlug,
      detail: text.length > 240 ? text.slice(0, 240) + '…' : text,
    });

    const occ: OccurrenceInput = {
      source: 'ocr',
      tStartMs: tMs,
      tEndMs: tMs,
      text,
    };
    occurrences.push(occ);
    last = occ;
  }

  replaceOccurrences(sqlite, row.id, 'ocr', occurrences);
  return { kept: occurrences.length, framesProcessed };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
