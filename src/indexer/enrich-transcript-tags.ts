// Derive topical tags from each video's spoken transcript using a local LLM.
// Runs AFTER enrich:transcript (which produces media_items.transcript) and
// reads that text straight from the DB — no media file or ffmpeg needed.
//
//   1. Select videos whose transcript_tags_status='pending' and that have a
//      non-empty transcript.
//   2. extractTranscriptTags(transcript) → a small list of normalized tags.
//   3. Replace this item's source='transcript' media_tags with the new set
//      (visual 'auto' tags and 'user' tags are untouched).
//
// Resumable + re-runnable: transcript_tags_status flips to 'done' / 'failed'
// per row, so re-runs only pick up un-tagged transcripts — which doubles as
// the backfill path for transcripts generated before this pass existed.
//
//   pnpm enrich:transcript-tags                  # default library
//   pnpm enrich:transcript-tags --library robert # named library
//   pnpm enrich:transcript-tags --reset          # re-tag every transcript
//   pnpm enrich:transcript-tags --limit 5        # cap for testing

import { getRawSqlite } from '@/db/client';
import { DEFAULT_LIBRARY_SLUG, resolveLibrary } from '@/server/libraries';
import { extractTranscriptTags } from '@/ai/llm';
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
  transcript: string;
}

async function main() {
  installGracefulStop();
  const args = parseArgs(process.argv.slice(2));
  const library = resolveLibrary(args.librarySlug);
  const sqlite = getRawSqlite(library.slug);

  if (args.reset) {
    sqlite.exec(
      `UPDATE media_items SET transcript_tags_status = 'pending'
       WHERE transcript IS NOT NULL AND transcript != ''`,
    );
    console.log('Reset transcript_tags_status for all transcribed items.');
  }

  const limitClause = args.limit ? `LIMIT ${args.limit}` : '';
  const pending = sqlite.prepare(`
    SELECT id, uuid, filename, transcript
    FROM media_items
    WHERE transcript IS NOT NULL AND transcript != ''
      AND transcript_tags_status = 'pending'
      AND deleted_at IS NULL
    ORDER BY id
    ${limitClause}
  `).all() as unknown as PendingRow[];

  console.log(
    `Transcript tagging in library "${library.name}" (${library.slug}): ` +
    `${pending.length} transcript(s) to process.`,
  );
  if (pending.length === 0) return;

  const markStatus = sqlite.prepare(
    `UPDATE media_items SET transcript_tags_status = ?, updated_at = ? WHERE id = ?`,
  );
  const findOrCreateTag = sqlite.prepare(
    `INSERT INTO tags (user_id, name, source) VALUES (1, ?, 'transcript')
     ON CONFLICT(user_id, name) DO UPDATE SET name = excluded.name
     RETURNING id`,
  );
  const linkTag = sqlite.prepare(
    `INSERT OR IGNORE INTO media_tags (media_item_id, tag_id, confidence, source)
     VALUES (?, ?, NULL, 'transcript')`,
  );
  // Clear only transcript-sourced links so re-runs don't duplicate, and
  // visual ('auto') + manual ('user') tags survive untouched.
  const clearOldTags = sqlite.prepare(
    `DELETE FROM media_tags WHERE media_item_id = ? AND source = 'transcript'`,
  );

  let done = 0;
  let tagged = 0;
  let empty = 0;
  let failed = 0;
  let totalTags = 0;
  const start = Date.now();

  for (const row of pending) {
    if (shouldStop()) { console.log('\n[paused] stopping after current batch — progress saved.'); break; }
    emitProgress({
      step: 'Enrich: transcript tags',
      current: done + failed,
      total: pending.length,
      label: 'LLM topic tags',
      currentItem: row.uuid,
      currentItemKind: 'uuid',
      currentItemLibrary: library.slug,
    });

    const tStart = Date.now();
    try {
      const tags = await extractTranscriptTags(row.transcript);

      clearOldTags.run(row.id);
      for (const tagName of tags) {
        const tagRow = findOrCreateTag.get(tagName) as { id: number } | undefined;
        if (tagRow) linkTag.run(row.id, BigInt(tagRow.id));
      }
      markStatus.run('done', Date.now(), row.id);
      done++;
      totalTags += tags.length;
      if (tags.length > 0) tagged++; else empty++;

      // Surface the extracted tags as live text so the operator sees the
      // model's output, not just a counter.
      if (tags.length > 0) {
        emitProgress({
          step: 'Enrich: transcript tags',
          current: done + failed,
          total: pending.length,
          label: `${tags.length} tag(s)`,
          currentItem: row.uuid,
          currentItemKind: 'uuid',
          currentItemLibrary: library.slug,
          detail: tags.join(', '),
        });
      }

      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      process.stdout.write(
        `\n✓ ${row.filename}: ${tags.length} tag(s) [${tags.join(', ')}] (${elapsed}s)\n`,
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
    step: 'Enrich: transcript tags',
    current: pending.length,
    total: pending.length,
    label: `done — ${tagged} tagged, ${empty} no-tags, ${failed} failed`,
  });
  console.log(
    `\nDone. ${done} processed (${totalTags} tags total across ${tagged} item(s)), ` +
    `${empty} produced no tags, ${failed} failed in ${elapsed}s.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
