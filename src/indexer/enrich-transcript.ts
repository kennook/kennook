// Per-video audio transcription with Whisper. For each video with
// transcript_status='pending':
//
//   1. ffmpeg extracts mono 16 kHz PCM from the audio track
//   2. Whisper (transformers.js) transcribes with chunk-level timestamps
//   3. Each chunk becomes a media_text_occurrences row (source='transcript')
//   4. The deduped rollup feeds media_items.transcript so the existing FTS5
//      index keeps matching unchanged
//
// Resumable: transcript_status flips to 'done' / 'failed' / 'no-audio' per
// row, so re-runs only pick up un-processed videos.
//
//   pnpm enrich:transcript                  # personal library
//   pnpm enrich:transcript --library work   # named library
//   pnpm enrich:transcript --reset          # re-transcribe every video
//   pnpm enrich:transcript --limit 5        # cap for testing

import fs from 'node:fs';
import { getRawSqlite } from '@/db/client';
import {
  DEFAULT_LIBRARY_SLUG,
  resolveLibrary,
} from '@/server/libraries';
import { parseRootPath, resolveMediaPath } from '@/server/storage';
import { extractMonoPcm16k, ensureFfmpegAvailable } from './ffmpeg';
import { pcmS16ToFloat32, transcribeWithTimestamps } from '@/ai/voice';
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
}

function parseArgs(argv: string[]): Args {
  let librarySlug = DEFAULT_LIBRARY_SLUG;
  let reset = false;
  let limit: number | null = null;
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
    }
  }
  return { librarySlug, reset, limit };
}

interface PendingRow {
  id: number;
  uuid: string;
  filename: string;
  rel_path: string;
  storage_config: string;
}

async function main() {
  installGracefulStop();
  const args = parseArgs(process.argv.slice(2));
  const library = resolveLibrary(args.librarySlug);
  const sqlite = getRawSqlite(library.slug);

  if (!(await ensureFfmpegAvailable())) {
    console.error('ffmpeg not available on PATH — install via `brew install ffmpeg`.');
    process.exit(2);
  }

  if (args.reset) {
    sqlite.exec(`UPDATE media_items SET transcript_status = 'pending' WHERE kind = 'video'`);
    console.log('Reset transcript_status for all videos.');
  }

  const limitClause = args.limit ? `LIMIT ${args.limit}` : '';
  const pending = sqlite.prepare(`
    SELECT m.id, m.uuid, m.filename, m.path AS rel_path, sl.config AS storage_config
    FROM media_items m
    JOIN storage_locations sl ON sl.id = m.storage_location_id
    WHERE m.kind = 'video'
      AND m.transcript_status = 'pending'
      AND m.deleted_at IS NULL
    ORDER BY m.id
    ${limitClause}
  `).all() as unknown as PendingRow[];

  console.log(
    `Transcription in library "${library.name}" (${library.slug}): ` +
    `${pending.length} video(s) to process.`,
  );
  if (pending.length === 0) return;

  const markStatus = sqlite.prepare(
    `UPDATE media_items SET transcript_status = ?, updated_at = ? WHERE id = ?`,
  );

  let done = 0;
  let noAudio = 0;
  let failed = 0;
  let totalSegments = 0;
  const start = Date.now();

  for (const row of pending) {
    if (shouldStop()) { console.log('\n[paused] stopping after current batch — progress saved.'); break; }
    emitProgress({
      step: 'Enrich: transcript',
      current: done + failed + noAudio,
      total: pending.length,
      label: 'audio extract + whisper',
      currentItem: row.uuid,
      currentItemKind: 'uuid',
      currentItemLibrary: library.slug,
    });

    const abs = resolveMediaPath(parseRootPath(row.storage_config), row.rel_path);
    if (!fs.existsSync(abs)) {
      failed++;
      markStatus.run('failed', Date.now(), row.id);
      process.stdout.write(`\n✗ ${row.filename}: file missing on disk\n`);
      continue;
    }

    const tStart = Date.now();
    try {
      const pcm = await extractMonoPcm16k(abs);
      if (pcm.byteLength === 0) {
        noAudio++;
        // Clear any stale transcript occurrences from a prior run that had audio.
        replaceOccurrences(sqlite, row.id, 'transcript', []);
        markStatus.run('no-audio', Date.now(), row.id);
        process.stdout.write(`\n· ${row.filename}: no audio stream\n`);
        continue;
      }

      const samples = pcmS16ToFloat32(pcm);
      const { segments } = await transcribeWithTimestamps(samples);

      const occurrences: OccurrenceInput[] = segments.map((s) => ({
        source: 'transcript',
        tStartMs: s.startMs,
        tEndMs: s.endMs,
        text: s.text,
      }));

      replaceOccurrences(sqlite, row.id, 'transcript', occurrences);
      totalSegments += occurrences.length;
      done++;
      markStatus.run('done', Date.now(), row.id);

      // Live text: surface a snippet of what was transcribed so the user
      // sees the spoken content, not just a counter. (Whisper returns all
      // segments at once, so this is per-video rather than per-segment for
      // now — streaming is a follow-up.)
      const joined = occurrences.map((o) => o.text).join(' ').trim();
      if (joined) {
        emitProgress({
          step: 'Enrich: transcript',
          current: done + failed + noAudio,
          total: pending.length,
          label: `${occurrences.length} segment(s)`,
          currentItem: row.uuid,
          currentItemKind: 'uuid',
          currentItemLibrary: library.slug,
          detail: joined.length > 280 ? joined.slice(0, 280) + '…' : joined,
        });
      }

      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      process.stdout.write(
        `\n✓ ${row.filename}: ${occurrences.length} segment(s) (${elapsed}s)\n`,
      );
    } catch (e) {
      failed++;
      markStatus.run('failed', Date.now(), row.id);
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`\n✗ ${row.filename}: ${msg}\n`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  emitProgress({
    step: 'Enrich: transcript',
    current: pending.length,
    total: pending.length,
    label: `done — ${done} transcribed, ${noAudio} no-audio, ${failed} failed`,
  });
  console.log(
    `\nDone. ${done} transcribed (${totalSegments} segments total), ` +
    `${noAudio} no-audio, ${failed} failed in ${elapsed}s.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
