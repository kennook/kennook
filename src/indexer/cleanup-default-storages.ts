// One-shot: drop the pre-Phase-3 default "Local @ /" storage_location from
// every library. Safe iff that row has zero media_items pointing at it
// (which is the expected state after `pnpm extract-storages --apply`).
//
//   pnpm cleanup-default-storages              # dry-run
//   pnpm cleanup-default-storages --apply      # commit

import { getRawSqlite } from '@/db/client';
import { listLibraries } from '@/server/libraries';
import { parseRootPath } from '@/server/storage';

interface Outcome {
  librarySlug: string;
  candidates: { id: number; name: string; files: number; removed: boolean; reason?: string }[];
}

function planOne(slug: string, apply: boolean): Outcome {
  const sqlite = getRawSqlite(slug);
  const rows = sqlite
    .prepare(`SELECT id, name, config FROM storage_locations`)
    .all() as { id: number; name: string; config: string }[];

  const counts = sqlite
    .prepare(`SELECT storage_location_id AS id, COUNT(*) AS n FROM media_items WHERE deleted_at IS NULL GROUP BY storage_location_id`)
    .all() as { id: number; n: number }[];
  const countMap = new Map(counts.map((c) => [c.id, c.n]));

  const outcome: Outcome = { librarySlug: slug, candidates: [] };
  for (const r of rows) {
    if (parseRootPath(r.config) !== '/') continue; // only the catch-all
    const files = countMap.get(r.id) ?? 0;
    const entry = { id: r.id, name: r.name, files, removed: false } as Outcome['candidates'][number];

    if (files > 0) {
      entry.reason = `${files} media_items still reference this storage — refusing to delete`;
    } else if (apply) {
      try {
        sqlite.prepare(`DELETE FROM storage_locations WHERE id = ?`).run(r.id);
        entry.removed = true;
      } catch (err) {
        entry.reason = err instanceof Error ? err.message : String(err);
      }
    }

    outcome.candidates.push(entry);
  }
  return outcome;
}

function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '─── APPLYING cleanup ───' : '─── DRY-RUN (pass --apply to commit) ───');

  for (const lib of listLibraries()) {
    const outcome = planOne(lib.slug, apply);
    console.log(`\n[library: ${outcome.librarySlug}]`);
    if (outcome.candidates.length === 0) {
      console.log('  (no catch-all storage_location at "/" — already clean)');
      continue;
    }
    for (const c of outcome.candidates) {
      const status = c.removed
        ? `REMOVED (files=${c.files})`
        : c.reason
          ? `SKIP — ${c.reason}`
          : `would remove (files=${c.files})`;
      console.log(`  [${c.id}] ${c.name}: ${status}`);
    }
  }

  if (!apply) console.log('\n(no changes written — re-run with --apply to commit)');
  else console.log('\nDone.');
}

main();
