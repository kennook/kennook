// Delete ALL face data across every library + all clustered people, and re-arm
// detection. Throws away only recomputable data (face boxes, embeddings, person
// clusters) — never source media. Use it to get a clean slate before a fresh
// enrich, or to clear a test run.
//
//   pnpm face:reset            # wipe everything
//   pnpm face:reset --library robert   # wipe just one library's faces
//
// After this, faces/people are empty until you run enrich:faces
// (+ enrich:people) again.

import { getRawSqlite } from '@/db/client';
import { getUserSqlite } from '@/db/user-client';
import { listLibraries, resolveLibrary } from '@/server/libraries';

function parseArgs(argv: string[]): { library: string | null } {
  let library: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library' || a === '-w') library = argv[++i] ?? null;
    else if (a.startsWith('--library=')) library = a.split('=')[1];
  }
  return { library };
}

function main() {
  const { library } = parseArgs(process.argv.slice(2));
  const targets = library ? [resolveLibrary(library)] : listLibraries();

  let faces = 0;
  for (const ws of targets) {
    const db = getRawSqlite(ws.slug);
    faces += (db.prepare('SELECT COUNT(*) c FROM media_faces').get() as { c: number }).c;
    db.exec('DELETE FROM media_face_embeddings');
    db.exec('DELETE FROM media_faces');
    db.exec(`UPDATE media_items SET face_status = 'pending' WHERE kind = 'photo'`);
    db.exec(`UPDATE media_items SET video_face_status = 'pending' WHERE kind = 'video'`);
    console.log(`  ${ws.slug}: face data cleared`);
  }

  // People live in user.db and are cross-library. If we wiped every library,
  // drop all clusters; if a single library, only drop clusters left empty.
  const userDb = getUserSqlite();
  if (!library) {
    const n = (userDb.prepare('SELECT COUNT(*) c FROM people WHERE user_id = 1').get() as { c: number }).c;
    userDb.exec('DELETE FROM people WHERE user_id = 1');
    console.log(`  people: ${n} cluster(s) dropped`);
  } else {
    // Recompute face_count from remaining libraries; delete any now at zero.
    const counts = new Map<number, number>();
    for (const ws of listLibraries()) {
      for (const r of getRawSqlite(ws.slug).prepare('SELECT person_id pid, COUNT(*) c FROM media_faces WHERE person_id IS NOT NULL GROUP BY person_id').all() as Array<{ pid: number; c: number }>) {
        counts.set(r.pid, (counts.get(r.pid) ?? 0) + r.c);
      }
    }
    const people = userDb.prepare('SELECT id FROM people WHERE user_id = 1').all() as Array<{ id: number }>;
    let dropped = 0;
    const del = userDb.prepare('DELETE FROM people WHERE id = ?');
    const upd = userDb.prepare('UPDATE people SET face_count = ? WHERE id = ?');
    for (const p of people) {
      const c = counts.get(p.id) ?? 0;
      if (c === 0) { del.run(p.id); dropped++; } else upd.run(c, p.id);
    }
    console.log(`  people: ${dropped} now-empty cluster(s) dropped`);
  }

  console.log(`\nCleared ${faces} face(s) across ${targets.length} librar(y/ies). Re-run enrich to rebuild.`);
}

main();
