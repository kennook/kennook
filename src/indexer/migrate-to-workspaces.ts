// One-shot migration: move pre-workspace data into the personal workspace.
//
// Before: data/kennook.db, data/thumbnails/*.jpg
// After:  data/personal/kennook.db, data/personal/thumbnails/*.jpg
//
// Also rewrites the thumbnail_path column on every media_items row so the app
// can serve thumbnails from their new location.
//
// Run with: pnpm tsx src/indexer/migrate-to-workspaces.ts

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { workspaceDbPath, workspaceThumbnailsDir } from '@/server/workspaces';

const DATA_ROOT = process.env.KENNOOK_DATA_ROOT ?? './data';
const OLD_DB = path.join(DATA_ROOT, 'kennook.db');
const OLD_THUMBS = path.join(DATA_ROOT, 'thumbnails');

const NEW_DB = workspaceDbPath('personal');
const NEW_THUMBS = workspaceThumbnailsDir('personal');

function exists(p: string) {
  return fs.existsSync(p);
}

function moveFile(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}

async function main() {
  if (!exists(OLD_DB) && !exists(OLD_THUMBS)) {
    console.log('Nothing to migrate — no pre-workspace data found.');
    return;
  }

  if (exists(NEW_DB)) {
    console.error(
      `Refusing to migrate: ${NEW_DB} already exists. ` +
      `Move or remove the personal workspace files first, then re-run.`,
    );
    process.exit(1);
  }

  // 1. Move the DB file (and WAL/SHM siblings if present).
  if (exists(OLD_DB)) {
    console.log(`Moving ${OLD_DB} → ${NEW_DB}`);
    moveFile(OLD_DB, NEW_DB);
    for (const ext of ['-wal', '-shm']) {
      const src = OLD_DB + ext;
      if (exists(src)) moveFile(src, NEW_DB + ext);
    }
  }

  // 2. Move thumbnails directory.
  if (exists(OLD_THUMBS)) {
    console.log(`Moving ${OLD_THUMBS} → ${NEW_THUMBS}`);
    fs.mkdirSync(path.dirname(NEW_THUMBS), { recursive: true });
    if (!exists(NEW_THUMBS)) {
      fs.renameSync(OLD_THUMBS, NEW_THUMBS);
    } else {
      // Defensive: move file-by-file if NEW_THUMBS already exists.
      for (const f of fs.readdirSync(OLD_THUMBS)) {
        fs.renameSync(path.join(OLD_THUMBS, f), path.join(NEW_THUMBS, f));
      }
      fs.rmdirSync(OLD_THUMBS);
    }
  }

  // 3. Rewrite thumbnail_path on every row to point to the new directory.
  if (exists(NEW_DB)) {
    console.log(`Rewriting thumbnail_path values in ${NEW_DB}`);
    const db = new DatabaseSync(NEW_DB);
    const result = db
      .prepare(
        `UPDATE media_items
         SET thumbnail_path = REPLACE(thumbnail_path, ?, ?)
         WHERE thumbnail_path LIKE ?`,
      )
      .run(OLD_THUMBS + path.sep, NEW_THUMBS + path.sep, OLD_THUMBS + '%');
    console.log(`  updated ${result.changes} rows.`);
    db.close();
  }

  console.log('\nMigration complete. The 138 (or however many) items are now in workspace "personal".');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
