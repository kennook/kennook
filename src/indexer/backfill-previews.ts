// One-shot backfill: for every photo media_item that doesn't yet have a
// preview_path, generate a 2048px preview from the original file and store it
// at data/<slug>/previews/{uuid}.jpg.
//
// Run with:
//   pnpm backfill:previews                  # personal library
//   pnpm backfill:previews --library work # named library

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

interface Row {
  id: number;
  uuid: string;
  filename: string;
  kind: 'photo' | 'video';
  rel_path: string;
  storage_config: string;
  preview_path: string | null;
}

function parseLibrary(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library' || a === '-w') {
      const v = argv[++i];
      if (v) return v;
    } else if (a.startsWith('--library=')) {
      return a.split('=')[1];
    }
  }
  return DEFAULT_LIBRARY_SLUG;
}

async function main() {
  const library = resolveLibrary(parseLibrary(process.argv.slice(2)));
  const sqlite = getRawSqlite(library.slug);

  console.log(`Backfilling previews in library "${library.name}" (${library.slug})`);

  const missing = sqlite
    .prepare(
      `SELECT m.id, m.uuid, m.filename, m.kind,
              m.path AS rel_path, sl.config AS storage_config, m.preview_path
       FROM media_items m
       JOIN storage_locations sl ON sl.id = m.storage_location_id
       WHERE m.kind = 'photo'
         AND m.deleted_at IS NULL
         AND (m.preview_path IS NULL OR m.preview_path = '')`,
    )
    .all() as unknown as Row[];

  if (!missing.length) {
    console.log('Nothing to backfill — every photo already has a preview.');
    return;
  }

  const previewDir = path.join(libraryRoot(library.slug), 'previews');
  fs.mkdirSync(previewDir, { recursive: true });

  console.log(`Generating ${missing.length} preview(s)...`);

  const update = sqlite.prepare(
    'UPDATE media_items SET preview_path = ? WHERE id = ?',
  );

  let done = 0;
  let failed = 0;
  const start = Date.now();

  for (const row of missing) {
    const absSource = resolveMediaPath(parseRootPath(row.storage_config), row.rel_path);
    if (!fs.existsSync(absSource)) {
      failed++;
      process.stdout.write(`\n✗ ${row.filename}: source file not found (${absSource})\n`);
      continue;
    }
    const previewPath = path.join(previewDir, `${row.uuid}.jpg`);
    try {
      const oriented = await sharp(absSource).rotate().toBuffer();
      await sharp(oriented)
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(previewPath);
      update.run(previewPath, row.id);
      done++;
      process.stdout.write(`\r✓ ${done} generated, ${failed} failed   `);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n✗ ${row.filename}: ${msg}\n`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone. Generated ${done}, failed ${failed} in ${elapsed}s.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
