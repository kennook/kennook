// One-shot: install a curated storage_location per library and reassign
// existing media_items from the default "/" catch-all to the new storage,
// recomputing each row's `path` to be relative to the new root.
//
// Plan is hard-coded — this is a one-time migration. Dry-run by default;
// pass --apply to commit.
//
//   pnpm extract-storages              # dry-run
//   pnpm extract-storages --apply      # commit

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getRawSqlite } from '@/db/client';
import { resolveLibrary } from '@/server/libraries';
import { createStorage, parseRootPath } from '@/server/storage';

interface Plan {
  librarySlug: string;
  storages: { name: string; rootPath: string }[];
}

const HOME = os.homedir();
function expand(p: string): string {
  return p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
}

const PLAN: Plan[] = [
  {
    librarySlug: 'personal',
    storages: [
      { name: 'Personal', rootPath: '~/Downloads/samples' },
      { name: 'Personal', rootPath: '~/Downloads/sample-images' },
    ],
  },
  {
    librarySlug: 'robert',
    storages: [
      { name: 'Robert', rootPath: '~/Downloads/other-samples' },
    ],
  },
  {
    librarySlug: 'documents',
    storages: [
      { name: 'Documents', rootPath: '/Volumes/Expansion/Downloads' },
    ],
  },
  {
    librarySlug: 'amazon-photos',
    storages: [
      { name: 'Amazon Photos', rootPath: '~/Downloads/amazon-photos' },
    ],
  },
  {
    librarySlug: 'trailers',
    storages: [
      { name: 'Trailers', rootPath: '/Volumes/Expansion/trailers' },
    ],
  },
];

interface Outcome {
  librarySlug: string;
  perStorage: {
    name: string;
    rootPath: string;
    rootExists: boolean;
    matchingRows: number;
    newStorageId?: number;
    rowsReassigned?: number;
    error?: string;
  }[];
}

function planOne(librarySlug: string, storages: { name: string; rootPath: string }[], apply: boolean): Outcome {
  const sqlite = getRawSqlite(librarySlug);
  const outcome: Outcome = { librarySlug, perStorage: [] };

  for (const s of storages) {
    const absRoot = path.resolve(expand(s.rootPath));
    const rootExists = fs.existsSync(absRoot) && fs.statSync(absRoot).isDirectory();
    const entry: Outcome['perStorage'][number] = {
      name: s.name,
      rootPath: absRoot,
      rootExists,
      matchingRows: 0,
    };

    // Match rows in the default "/" catch-all whose abs path lives under absRoot.
    // After v10, media_items.path is rel to its storage's root. For the default
    // (root="/"), abs == "/" + path, so we look for rows where path starts with
    // absRoot.slice(1) + "/".
    const groupPrefix = absRoot.slice(1); // strip leading "/"
    const likeArg = `${groupPrefix}/%`;

    // Find the default catch-all storage (root_path = "/") for this library.
    // We only migrate from there — already-customized storages are off-limits.
    const defaults = sqlite
      .prepare(`SELECT id, config FROM storage_locations`)
      .all() as { id: number; config: string }[];
    const defaultStorage = defaults.find((d) => parseRootPath(d.config) === '/');
    if (!defaultStorage) {
      entry.error = 'no catch-all storage at "/" found in this library';
      outcome.perStorage.push(entry);
      continue;
    }

    const countRow = sqlite
      .prepare(`
        SELECT COUNT(*) AS n FROM media_items
        WHERE storage_location_id = ? AND path LIKE ? AND deleted_at IS NULL
      `)
      .get(defaultStorage.id, likeArg) as { n: number };
    entry.matchingRows = countRow.n;

    if (!apply) {
      outcome.perStorage.push(entry);
      continue;
    }

    if (!rootExists) {
      entry.error = 'root does not exist on disk — skipping creation';
      outcome.perStorage.push(entry);
      continue;
    }

    // Need to allow duplicate-name + overlap-with-defaults. createStorage in
    // storage.ts already permits "/" coexistence; same-name duplicates are not
    // schema-restricted either.
    try {
      const { id: newId } = createStorage(sqlite, { name: s.name, root_path: absRoot });
      entry.newStorageId = newId;

      // Reassign rows: storage_location_id → new, path = substr(old_path, len(prefix)+2).
      // (+2 because SQLite substr is 1-indexed, and we strip prefix + slash.)
      const result = sqlite
        .prepare(`
          UPDATE media_items
          SET storage_location_id = ?, path = substr(path, ?)
          WHERE storage_location_id = ? AND path LIKE ?
        `)
        .run(newId, groupPrefix.length + 2, defaultStorage.id, likeArg);
      entry.rowsReassigned = Number(result.changes);
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }

    outcome.perStorage.push(entry);
  }

  return outcome;
}

function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '─── APPLYING extraction ───' : '─── DRY-RUN (pass --apply to commit) ───');

  for (const p of PLAN) {
    // resolveLibrary throws if the slug isn't in libraries.json — surface early.
    try {
      resolveLibrary(p.librarySlug);
    } catch (e) {
      console.log(`\n[library: ${p.librarySlug}]  SKIPPED — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const outcome = planOne(p.librarySlug, p.storages, apply);

    console.log(`\n[library: ${outcome.librarySlug}]`);
    for (const s of outcome.perStorage) {
      const flag = s.rootExists ? '✓' : '✗';
      console.log(`  ${flag} ${s.name}`);
      console.log(`     root:           ${s.rootPath}${s.rootExists ? '' : '   (does not exist)'}`);
      console.log(`     matching rows:  ${s.matchingRows}`);
      if (apply) {
        if (s.error) {
          console.log(`     ERROR:          ${s.error}`);
        } else {
          console.log(`     created id:     ${s.newStorageId}`);
          console.log(`     reassigned:     ${s.rowsReassigned}`);
        }
      }
    }
  }

  if (!apply) {
    console.log('\n(no changes written — re-run with --apply to commit)');
  } else {
    console.log('\nDone.');
  }
}

main();
