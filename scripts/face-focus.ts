/**
 * Face-focus maintenance — inspect / back up / reset / recompute the face-aware
 * framing focal points (media_items.face_focus_x/y).
 *
 * The focal point is the CENTRE of the union bounding box of an item's detected
 * faces (normalized 0..1) — see src/ai/face.ts `faceFocusPoint`. The UI crops
 * thumbnails + defaults the viewer pan to it.
 *
 * Why this exists: if photos look off-centre you can't tell whether it's a STALE
 * stored value (from an older run) or the current algorithm's actual output.
 * This lets you back up the current values, then either clear them (fall back to
 * a plain centre crop) or RECOMPUTE them from the already-detected faces (the
 * current algorithm, no slow re-detection) — and it reports how many CHANGED, so
 * you learn whether the stored values were stale or not. `--restore` puts a
 * backup back.
 *
 * Usage (run per library with --library <slug>; defaults to the default library):
 *   pnpm exec tsx scripts/face-focus.ts --backup
 *   pnpm exec tsx scripts/face-focus.ts --recompute      # backs up first, then re-derives
 *   pnpm exec tsx scripts/face-focus.ts --clear          # backs up first, then nulls
 *   pnpm exec tsx scripts/face-focus.ts --restore <file>
 */

import fs from 'node:fs';
import path from 'node:path';
import { getRawSqlite } from '@/db/client';
import { resolveLibrary, libraryRoot } from '@/server/libraries';

type Mode = 'backup' | 'recompute' | 'clear' | 'restore';

interface Args { librarySlug?: string; mode: Mode; restoreFile?: string }

function parseArgs(argv: string[]): Args {
  let librarySlug: string | undefined;
  let mode: Mode | null = null;
  let restoreFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library' || a === '-l') librarySlug = argv[++i];
    else if (a.startsWith('--library=')) librarySlug = a.split('=')[1];
    else if (a === '--backup') mode = 'backup';
    else if (a === '--recompute') mode = 'recompute';
    else if (a === '--clear') mode = 'clear';
    else if (a === '--restore') { mode = 'restore'; restoreFile = argv[++i]; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!mode) throw new Error('Pick a mode: --backup | --recompute | --clear | --restore <file>');
  if (mode === 'restore' && !restoreFile) throw new Error('--restore needs a backup file path');
  return { librarySlug, mode, restoreFile };
}

interface Row { uuid: string; x: number | null; y: number | null }

function backup(sqlite: ReturnType<typeof getRawSqlite>, slug: string): string {
  const rows = sqlite.prepare(
    `SELECT uuid, face_focus_x AS x, face_focus_y AS y FROM media_items
      WHERE face_focus_x IS NOT NULL OR face_focus_y IS NOT NULL`,
  ).all() as unknown as Row[];
  const dir = libraryRoot(slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `face-focus-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  console.log(`Backed up ${rows.length} focal point(s) → ${file}`);
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const library = resolveLibrary(args.librarySlug);
  const sqlite = getRawSqlite(library.slug);
  console.log(`Library "${library.name}" (${library.slug})`);

  if (args.mode === 'backup') {
    backup(sqlite, library.slug);
    return;
  }

  if (args.mode === 'restore') {
    const rows = JSON.parse(fs.readFileSync(args.restoreFile!, 'utf8')) as Row[];
    const upd = sqlite.prepare('UPDATE media_items SET face_focus_x = ?, face_focus_y = ? WHERE uuid = ?');
    let n = 0;
    for (const r of rows) { if (upd.run(r.x, r.y, r.uuid).changes) n++; }
    console.log(`Restored ${n}/${rows.length} focal point(s) from ${args.restoreFile}`);
    return;
  }

  // clear / recompute both back up first.
  backup(sqlite, library.slug);

  const before = sqlite.prepare(
    'SELECT COUNT(*) AS n FROM media_items WHERE face_focus_x IS NOT NULL',
  ).get() as { n: number };

  // Snapshot old values to count how many actually change.
  const old = new Map<string, string>();
  for (const r of sqlite.prepare(
    'SELECT uuid, face_focus_x AS x, face_focus_y AS y FROM media_items WHERE face_focus_x IS NOT NULL',
  ).all() as unknown as Row[]) {
    old.set(r.uuid, `${r.x},${r.y}`);
  }

  // Always clear first.
  sqlite.exec('UPDATE media_items SET face_focus_x = NULL, face_focus_y = NULL');

  if (args.mode === 'recompute') {
    // Re-derive from the already-detected faces using the CURRENT algorithm
    // (centre of the union of face boxes) — no re-detection needed.
    sqlite.exec(`
      UPDATE media_items
         SET face_focus_x = min(1.0, max(0.0, s.cx / media_items.width)),
             face_focus_y = min(1.0, max(0.0, s.cy / media_items.height))
        FROM (
          SELECT media_item_id,
                 (min(bbox_x) + max(bbox_x + bbox_w)) / 2.0 AS cx,
                 (min(bbox_y) + max(bbox_y + bbox_h)) / 2.0 AS cy
            FROM media_faces GROUP BY media_item_id
        ) AS s
       WHERE media_items.id = s.media_item_id
         AND media_items.width > 0 AND media_items.height > 0
    `);

    const now = sqlite.prepare(
      'SELECT uuid, face_focus_x AS x, face_focus_y AS y FROM media_items WHERE face_focus_x IS NOT NULL',
    ).all() as unknown as Row[];
    let changed = 0;
    for (const r of now) {
      const prev = old.get(r.uuid);
      // Compare at ~3-decimal precision to ignore float noise.
      const cur = `${r.x?.toFixed(3)},${r.y?.toFixed(3)}`;
      const was = prev ? prev.split(',').map((v) => Number(v).toFixed(3)).join(',') : null;
      if (was !== cur) changed++;
    }
    console.log(`Recomputed from stored faces: ${now.length} now have a focal point (${before.n} did before).`);
    console.log(`Changed vs. the stored value: ${changed}. ${changed === 0
      ? '→ Stored values were already current — off-centre framing is the algorithm, not stale data.'
      : '→ Those were stale; the new values reflect the current algorithm.'}`);
  } else {
    console.log(`Cleared ${before.n} focal point(s) → items now use a plain centre crop.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
