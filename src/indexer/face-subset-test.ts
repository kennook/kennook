// Clean-slate face pipeline validation on a SMALL SUBSET.
//
// Purpose: prove the current detector+recognition+clustering pipeline produces
// good people BEFORE committing to a multi-hour full run. It (1) wipes ALL face
// data across every library so nothing stale leaks into clustering, (2) embeds
// a capped number of items from ONE library with the live pipeline, (3) clusters
// them, and (4) prints a summary + writes a montage of the biggest clusters'
// faces to /tmp so you can eyeball quality.
//
//   pnpm face:test                         # 150 photos from `personal`
//   pnpm face:test --library amazon-photos --limit 200
//
// SAFE-TO-RERUN, but DESTRUCTIVE to existing face data: it deletes every
// media_faces / media_face_embeddings row in all libraries and re-arms
// detection. Face detection is cheap to redo; this only throws away
// recomputable data, never source media.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import sharp from 'sharp';
import { getRawSqlite } from '@/db/client';
import { getUserSqlite } from '@/db/user-client';
import { listLibraries, DEFAULT_LIBRARY_SLUG } from '@/server/libraries';
import { parseRootPath, resolveMediaPath } from '@/server/storage';

interface Args { library: string; limit: number }
function parseArgs(argv: string[]): Args {
  const a: Args = { library: DEFAULT_LIBRARY_SLUG, limit: 150 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--library' || arg === '-w') a.library = argv[++i] ?? a.library;
    else if (arg.startsWith('--library=')) a.library = arg.split('=')[1];
    else if (arg === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (arg.startsWith('--limit=')) a.limit = parseInt(arg.split('=')[1], 10);
  }
  return a;
}

function wipeAllFaceData(): void {
  for (const ws of listLibraries()) {
    const db = getRawSqlite(ws.slug);
    db.exec('DELETE FROM media_face_embeddings');
    db.exec('DELETE FROM media_faces');
    db.exec(`UPDATE media_items SET face_status = 'pending' WHERE kind = 'photo'`);
    db.exec(`UPDATE media_items SET video_face_status = 'pending' WHERE kind = 'video'`);
  }
}

const OUT = '/tmp/face-test';

async function montageTopClusters(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const people = getUserSqlite().prepare(
    `SELECT id, face_count FROM people WHERE user_id = 1 ORDER BY face_count DESC LIMIT 16`,
  ).all() as Array<{ id: number; face_count: number }>;
  if (people.length === 0) return;

  async function repCrop(pid: number): Promise<Buffer | null> {
    for (const ws of listLibraries()) {
      const db = getRawSqlite(ws.slug);
      const f = db.prepare(
        `SELECT media_item_id mid, bbox_x bx, bbox_y by_, bbox_w bw, bbox_h bh
         FROM media_faces WHERE person_id = ? ORDER BY confidence DESC LIMIT 1`,
      ).get(pid) as { mid: number; bx: number; by_: number; bw: number; bh: number } | undefined;
      if (!f) continue;
      const r = db.prepare(
        `SELECT m.path p, sl.config cfg FROM media_items m
         JOIN storage_locations sl ON sl.id = m.storage_location_id WHERE m.id = ?`,
      ).get(f.mid) as { p: string; cfg: string } | undefined;
      if (!r) continue;
      const abs = resolveMediaPath(parseRootPath(r.cfg), r.p);
      if (!fs.existsSync(abs)) continue;
      try {
        const img = sharp(abs, { failOn: 'none' }).rotate();
        const m = await img.metadata(); const W = m.width ?? 0; const H = m.height ?? 0;
        const left = Math.max(0, Math.min(f.bx, W - 1)); const top = Math.max(0, Math.min(f.by_, H - 1));
        return await img.extract({ left, top, width: Math.max(1, Math.min(f.bw, W - left)), height: Math.max(1, Math.min(f.bh, H - top)) })
          .resize(100, 100, { fit: 'cover' }).jpeg().toBuffer();
      } catch { /* try next library */ }
    }
    return null;
  }

  const crops: Buffer[] = [];
  for (const p of people) { const c = await repCrop(p.id); if (c) crops.push(c); }
  if (!crops.length) return;
  const cols = 8; const rows = Math.ceil(crops.length / cols);
  await sharp({ create: { width: 100 * cols, height: 100 * rows, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite(crops.map((b, k) => ({ input: b, left: (k % cols) * 100, top: Math.floor(k / cols) * 100 })))
    .jpeg().toFile(`${OUT}/top-clusters.jpg`);
  console.log(`\nMontage of the ${crops.length} biggest clusters → ${OUT}/top-clusters.jpg`);
  console.log('  (each tile is a DIFFERENT person — if you see the same face repeated, clustering is fragmenting)');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('═'.repeat(70));
  console.log(`FACE SUBSET TEST — ${args.limit} photos from "${args.library}"`);
  console.log('═'.repeat(70));

  console.log('\n[1/4] Clean slate: wiping ALL face data across every library…');
  wipeAllFaceData();
  console.log('      done — all libraries re-armed for detection.');

  console.log(`\n[2/4] Embedding ${args.limit} photos with the live pipeline…\n`);
  execSync(`pnpm enrich:faces --library ${args.library} --limit ${args.limit}`, { stdio: 'inherit' });

  console.log('\n[3/4] Clustering into people…\n');
  execSync('pnpm enrich:people --reset', { stdio: 'inherit' });

  console.log('\n[4/4] Summary');
  const s = getUserSqlite().prepare(
    `SELECT COUNT(*) people, COALESCE(MAX(face_count),0) largest,
            SUM(face_count = 1) singletons, SUM(face_count >= 2) multi
     FROM people WHERE user_id = 1`,
  ).get() as { people: number; largest: number; singletons: number; multi: number };
  const faces = listLibraries().reduce((n, ws) => n + (getRawSqlite(ws.slug).prepare('SELECT COUNT(*) c FROM media_faces').get() as { c: number }).c, 0);
  const top = getUserSqlite().prepare(`SELECT face_count FROM people WHERE user_id = 1 ORDER BY face_count DESC LIMIT 12`).all() as Array<{ face_count: number }>;
  console.log(`      faces embedded : ${faces}`);
  console.log(`      people (clusters): ${s.people}  (${s.multi} with ≥2 faces, ${s.singletons} singletons)`);
  console.log(`      largest cluster : ${s.largest} faces`);
  console.log(`      top sizes       : ${top.map((t) => t.face_count).join(', ')}`);

  await montageTopClusters();

  console.log('\nDone. Inspect the montage and the People section in the app.');
  console.log('This wiped face data everywhere — re-run a full enrich when you\'re happy with the results.');
}

main().catch((e) => { console.error(e); process.exit(1); });
