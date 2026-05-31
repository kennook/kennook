// One-shot face enrichment. For every photo with face_status='pending',
// detects faces, computes 128-d embeddings, stores rows in media_faces +
// media_face_embeddings, and marks the item done / no-faces / failed.
//
// Videos are skipped for now — pre-extracting representative frames is its
// own can of worms; will revisit when face search across videos becomes a
// concrete need.
//
// Run with:
//   pnpm enrich:faces                    # default library
//   pnpm enrich:faces --library work   # named library
//   pnpm enrich:faces --reset            # re-process items previously marked done
//   pnpm enrich:faces --limit 100        # cap how many to process (testing)

import path from 'node:path';
import fs from 'node:fs/promises';
import { DEFAULT_LIBRARY_SLUG, resolveLibrary } from '@/server/libraries';
import { getRawSqlite } from '@/db/client';
import { parseRootPath, resolveMediaPath } from '@/server/storage';
import { detectFaces, faceEmbeddingToBuffer } from '@/ai/face';
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

  if (args.reset) {
    sqlite.exec(`UPDATE media_items SET face_status = 'pending' WHERE kind = 'photo'`);
    sqlite.exec(`DELETE FROM media_faces`);
    sqlite.exec(`DELETE FROM media_face_embeddings`);
    console.log('Reset face data for all photos.');
  }

  const limitClause = args.limit ? `LIMIT ${args.limit}` : '';
  const pending = sqlite.prepare(`
    SELECT m.id, m.uuid, m.filename, m.path AS rel_path, sl.config AS storage_config
    FROM media_items m
    JOIN storage_locations sl ON sl.id = m.storage_location_id
    WHERE m.kind = 'photo'
      AND m.face_status = 'pending'
      AND m.deleted_at IS NULL
    ORDER BY m.id
    ${limitClause}
  `).all() as unknown as PendingRow[];

  console.log(
    `Face enrichment in library "${library.name}" (${library.slug}): ` +
    `${pending.length} photo(s) to process.`,
  );
  if (pending.length === 0) return;

  // Prepared statements reused inside the loop — meaningfully faster than
  // recreating them per row for large batches.
  const insertFace = sqlite.prepare(`
    INSERT INTO media_faces
      (media_item_id, bbox_x, bbox_y, bbox_w, bbox_h, confidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertEmbedding = sqlite.prepare(`
    INSERT INTO media_face_embeddings (rowid, embedding) VALUES (?, ?)
  `);
  const markStatus = sqlite.prepare(`
    UPDATE media_items SET face_status = ? WHERE id = ?
  `);

  let done = 0;
  let faces = 0;
  let failed = 0;
  const t0 = Date.now();

  for (const row of pending) {
    if (shouldStop()) { console.log('\n[paused] stopping after current batch — progress saved.'); break; }
    emitProgress({
      step: 'Enrich: faces',
      current: done + failed,
      total: pending.length,
      label: 'detecting faces + embeddings',
      currentItem: row.uuid,
      currentItemKind: 'uuid',
      currentItemLibrary: library.slug,
    });
    process.stdout.write(`[${done + 1}/${pending.length}] ${row.filename} … `);
    const absPath = resolveMediaPath(parseRootPath(row.storage_config), row.rel_path);
    try {
      await fs.access(absPath);
    } catch {
      markStatus.run('failed', row.id);
      failed++;
      console.log('SKIP (file missing)');
      continue;
    }
    try {
      const detected = await detectFaces(absPath);
      // INSERT face rows + their embeddings inside a transaction so a
      // crash mid-write doesn't leave the item half-enriched.
      sqlite.exec('BEGIN');
      try {
        for (const f of detected) {
          const res = insertFace.run(
            row.id,
            f.bbox.x, f.bbox.y, f.bbox.width, f.bbox.height,
            f.confidence,
          );
          // vec0's rowid takes BigInt — see media_embeddings indexer pattern.
          const faceId = BigInt(res.lastInsertRowid);
          insertEmbedding.run(faceId, faceEmbeddingToBuffer(f.embedding));
        }
        markStatus.run(detected.length > 0 ? 'done' : 'no-faces', row.id);
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      faces += detected.length;
      done++;
      console.log(`${detected.length} face(s)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markStatus.run('failed', row.id);
      failed++;
      console.log(`FAIL: ${msg}`);
    }
  }
  emitProgress({
    step: 'Enrich: faces',
    current: pending.length,
    total: pending.length,
    label: `done — ${done} processed, ${faces} face(s), ${failed} failed`,
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\nDone in ${dt}s — ${done} processed, ${failed} failed, ${faces} face(s) extracted.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Silence the unused-import warning if path isn't used elsewhere.
void path;
