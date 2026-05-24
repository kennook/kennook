// One-shot backfill: for every photo media_item that doesn't yet have a
// preview_path, generate a 2048px preview from the original file and store it
// at data/<slug>/previews/{uuid}.jpg.
//
// Run with:
//   pnpm backfill:previews                  # personal workspace
//   pnpm backfill:previews --workspace work # named workspace

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getRawSqlite } from '@/db/client';
import {
  DEFAULT_WORKSPACE_SLUG,
  resolveWorkspace,
  workspaceRoot,
} from '@/server/workspaces';

interface Row {
  id: number;
  uuid: string;
  filename: string;
  kind: 'photo' | 'video';
  path: string;
  preview_path: string | null;
}

function parseWorkspace(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '-w') {
      const v = argv[++i];
      if (v) return v;
    } else if (a.startsWith('--workspace=')) {
      return a.split('=')[1];
    }
  }
  return DEFAULT_WORKSPACE_SLUG;
}

async function main() {
  const workspace = resolveWorkspace(parseWorkspace(process.argv.slice(2)));
  const sqlite = getRawSqlite(workspace.slug);

  console.log(`Backfilling previews in workspace "${workspace.name}" (${workspace.slug})`);

  const missing = sqlite
    .prepare(
      `SELECT id, uuid, filename, kind, path, preview_path
       FROM media_items
       WHERE kind = 'photo'
         AND deleted_at IS NULL
         AND (preview_path IS NULL OR preview_path = '')`,
    )
    .all() as unknown as Row[];

  if (!missing.length) {
    console.log('Nothing to backfill — every photo already has a preview.');
    return;
  }

  const previewDir = path.join(workspaceRoot(workspace.slug), 'previews');
  fs.mkdirSync(previewDir, { recursive: true });

  console.log(`Generating ${missing.length} preview(s)...`);

  const update = sqlite.prepare(
    'UPDATE media_items SET preview_path = ? WHERE id = ?',
  );

  let done = 0;
  let failed = 0;
  const start = Date.now();

  for (const row of missing) {
    if (!fs.existsSync(row.path)) {
      failed++;
      process.stdout.write(`\n✗ ${row.filename}: source file not found (${row.path})\n`);
      continue;
    }
    const previewPath = path.join(previewDir, `${row.uuid}.jpg`);
    try {
      const oriented = await sharp(row.path).rotate().toBuffer();
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
