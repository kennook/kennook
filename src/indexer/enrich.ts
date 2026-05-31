// VLM enrichment pass — runs Florence-2 over indexed items to produce:
//   - ai_caption   (natural-language description)
//   - ocr_text     (any text extracted from the image)
//   - media_tags   (objects/concepts present, dedup'd)
//
// Designed to run AFTER the fast indexer, so users see thumbnails immediately
// and richness fills in over minutes/hours. Resumable: re-running picks up
// items where enrichment_status != 'done'.
//
// Usage:
//   pnpm enrich:text                         # personal library
//   pnpm enrich:text --library work        # named library
//   pnpm enrich:text --limit 100             # cap items per run (testing)
//   pnpm enrich:text --force                 # re-enrich items already done

import fs from 'node:fs';
import { getRawSqlite } from '@/db/client';
import { enrichImage } from '@/ai/vlm';
import { emitProgress } from './progress';
import {
  DEFAULT_LIBRARY_SLUG,
  resolveLibrary,
} from '@/server/libraries';
import { replaceOccurrences } from '@/server/text-occurrences';
import { installGracefulStop, shouldStop } from './graceful-stop';

interface PendingRow {
  id: number;
  uuid: string;
  filename: string;
  thumbnail_path: string | null;
  preview_path: string | null;
}

interface CliArgs {
  librarySlug: string;
  limit: number | null;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let librarySlug = DEFAULT_LIBRARY_SLUG;
  let limit: number | null = null;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // pnpm 9+ sometimes leaves a bare `--` separator in argv when scripts
    // chain through `pnpm <script> -- args`. Treat it as a no-op so a
    // version bump in the package manager can't crash us.
    if (a === '--') continue;
    if (a === '--library' || a === '-w') {
      const v = argv[++i];
      if (!v) throw new Error('--library requires a value');
      librarySlug = v;
    } else if (a.startsWith('--library=')) {
      librarySlug = a.split('=')[1];
    } else if (a === '--limit') {
      const v = argv[++i];
      if (!v) throw new Error('--limit requires a value');
      limit = parseInt(v, 10);
    } else if (a.startsWith('--limit=')) {
      limit = parseInt(a.split('=')[1], 10);
    } else if (a === '--force' || a === '-f') {
      force = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { librarySlug, limit, force };
}

async function main() {
  installGracefulStop();
  const { librarySlug, limit, force } = parseArgs(process.argv.slice(2));
  const library = resolveLibrary(librarySlug);
  const sqlite = getRawSqlite(library.slug);

  console.log(`Enriching library "${library.name}" (${library.slug}) with Florence-2`);
  console.log('First run will download ~250MB of model weights. Subsequent runs are cached.');

  // Pick up items needing enrichment. We use preview_path when available
  // (better OCR on text-heavy images), falling back to the thumbnail.
  const where = force
    ? 'deleted_at IS NULL AND (thumbnail_path IS NOT NULL OR preview_path IS NOT NULL)'
    : `deleted_at IS NULL AND enrichment_status != 'done'
       AND (thumbnail_path IS NOT NULL OR preview_path IS NOT NULL)`;

  const limitClause = limit ? `LIMIT ${limit}` : '';
  const pending = sqlite.prepare(`
    SELECT id, uuid, filename, thumbnail_path, preview_path
    FROM media_items
    WHERE ${where}
    ORDER BY id
    ${limitClause}
  `).all() as unknown as PendingRow[];

  if (!pending.length) {
    console.log('Nothing to enrich — everything is up to date.');
    return;
  }

  console.log(`${pending.length} item(s) pending.`);

  // ocr_text isn't set here — `replaceOccurrences` below handles both the
  // per-frame occurrence row AND the rollup column FTS5 reads from.
  const updateItem = sqlite.prepare(`
    UPDATE media_items
    SET ai_caption = ?, enrichment_status = 'done', updated_at = ?
    WHERE id = ?
  `);
  const markFailed = sqlite.prepare(`
    UPDATE media_items SET enrichment_status = 'failed', updated_at = ? WHERE id = ?
  `);
  const findOrCreateTag = sqlite.prepare(
    `INSERT INTO tags (user_id, name, source) VALUES (1, ?, 'auto')
     ON CONFLICT(user_id, name) DO UPDATE SET name = excluded.name
     RETURNING id`,
  );
  const linkTag = sqlite.prepare(
    `INSERT OR IGNORE INTO media_tags (media_item_id, tag_id, confidence, source)
     VALUES (?, ?, NULL, 'auto')`,
  );
  // Only clear AUTO-sourced media_tag links — user-added tags survive
  // re-enrichment (and re-runs won't keep duplicating them).
  const clearOldTags = sqlite.prepare(
    `DELETE FROM media_tags WHERE media_item_id = ? AND source = 'auto'`,
  );

  let done = 0;
  let failed = 0;
  const start = Date.now();

  for (let i = 0; i < pending.length; i++) {
    if (shouldStop()) { console.log('\n[paused] stopping after current batch — progress saved.'); break; }
    const row = pending[i];
    // Pre-process emit so the UI shows what's about to be processed
    // (useful when Florence-2 takes seconds per image).
    emitProgress({
      step: 'Enrich: text',
      current: done + failed,
      total: pending.length,
      label: 'captioning + OCR + tagging',
      currentItem: row.uuid,
      currentItemKind: 'uuid',
      currentItemLibrary: library.slug,
    });

    const imgPath = row.preview_path && fs.existsSync(row.preview_path)
      ? row.preview_path
      : row.thumbnail_path && fs.existsSync(row.thumbnail_path)
        ? row.thumbnail_path
        : null;

    if (!imgPath) {
      failed++;
      markFailed.run(Date.now(), row.id);
      process.stdout.write(`\n✗ ${row.filename}: no thumbnail or preview on disk\n`);
      continue;
    }

    const itemStart = Date.now();
    try {
      const { caption, ocrText, tags } = await enrichImage(imgPath);

      // Replace auto-tags atomically: clear existing auto-tags for this item,
      // then add the new set. Manual tags (source='user') are untouched.
      clearOldTags.run(row.id);
      updateItem.run(caption || null, Date.now(), row.id);

      // Write the OCR result as a single timestamp-less occurrence — photos
      // have no timeline. replaceOccurrences also updates ocr_text for FTS.
      replaceOccurrences(sqlite, row.id, 'ocr',
        ocrText ? [{ source: 'ocr', tStartMs: null, tEndMs: null, text: ocrText }] : [],
      );

      for (const tagName of tags) {
        const tagRow = findOrCreateTag.get(tagName) as { id: number } | undefined;
        if (tagRow) linkTag.run(row.id, BigInt(tagRow.id));
      }

      done++;
      const itemMs = Date.now() - itemStart;
      const tagPreview = tags.slice(0, 3).join(', ') + (tags.length > 3 ? '…' : '');
      process.stdout.write(
        `\r✓ ${done}/${pending.length} (${itemMs}ms) — ${row.filename.slice(0, 40)}  [${tagPreview}]\n`,
      );
    } catch (err) {
      failed++;
      markFailed.run(Date.now(), row.id);
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n✗ ${row.filename}: ${msg}\n`);
    }
  }

  emitProgress({
    step: 'Enrich: text',
    current: pending.length,
    total: pending.length,
    label: `done — ${done} enriched, ${failed} failed`,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone. Enriched ${done}, failed ${failed} in ${elapsed}s.`);
  if (failed > 0) {
    console.log('Failed items are marked enrichment_status=failed. Re-run to retry them, or fix the underlying issue first.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
