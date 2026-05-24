// One-shot backfill: for every media_item that has a thumbnail but no row in
// media_embeddings, generate a CLIP embedding from the thumbnail and insert it.
//
// Run with:
//   pnpm backfill:vectors                  # personal workspace
//   pnpm backfill:vectors --workspace work # named workspace

import fs from 'node:fs';
import { getRawSqlite } from '@/db/client';
import { embedImage, floatArrayToBuffer } from '@/ai/embeddings';
import { DEFAULT_WORKSPACE_SLUG, resolveWorkspace } from '@/server/workspaces';

interface Row {
  id: number;
  filename: string;
  thumbnail_path: string | null;
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

  console.log(`Backfilling embeddings in workspace "${workspace.name}" (${workspace.slug})`);

  const missing = sqlite
    .prepare(
      `SELECT m.id, m.filename, m.thumbnail_path
       FROM media_items m
       LEFT JOIN media_embeddings v ON v.rowid = m.id
       WHERE m.deleted_at IS NULL
         AND m.thumbnail_path IS NOT NULL
         AND v.rowid IS NULL`,
    )
    .all() as unknown as Row[];

  if (!missing.length) {
    console.log('Nothing to backfill — every media item already has an embedding.');
    return;
  }

  console.log(`Backfilling ${missing.length} embeddings...`);
  const insert = sqlite.prepare(
    'INSERT INTO media_embeddings (rowid, embedding) VALUES (?, ?)',
  );

  let done = 0;
  let failed = 0;
  const start = Date.now();

  for (const row of missing) {
    if (!row.thumbnail_path || !fs.existsSync(row.thumbnail_path)) {
      failed++;
      continue;
    }
    try {
      const embedding = await embedImage(row.thumbnail_path);
      insert.run(BigInt(row.id), floatArrayToBuffer(embedding));
      done++;
      process.stdout.write(`\r✓ ${done} embedded, ${failed} failed   `);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n✗ id=${row.id} (${row.filename}): ${msg}\n`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nBackfill complete. Embedded ${done}, failed ${failed} in ${elapsed}s.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
