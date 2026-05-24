// Cluster face embeddings into people. Cross-workspace.
//
// Algorithm: union-find with a same-person edge whenever Euclidean
// distance between two 128-d face-api descriptors falls below
// FACE_SAME_PERSON_THRESHOLD (0.6 — the convention from the face-api docs;
// descriptors are unit-norm so distances span 0 … 2).
//
// Re-runnable: existing `person_id` assignments are seeded as same-component
// before pairwise comparisons, so user labels survive subsequent runs and
// newly-detected faces just join their nearest existing cluster (or form
// new ones if no existing match is close enough).
//
// Performance: naive O(n²) pairwise distance — fine up to ~30 k faces
// (single-digit minutes on a modern laptop). Past that, the upgrade is
// vec0-based ANN: for each face, query the workspace's media_face_embeddings
// for the top-K nearest neighbours and only union against those. Same
// invariants, dramatically smaller constant.
//
// Run with:
//   pnpm enrich:people
//   pnpm enrich:people --threshold 0.55      # tighter (fewer matches)
//   pnpm enrich:people --reset               # drop all assignments + people
//                                              and re-cluster from scratch

import { listWorkspaces } from '@/server/workspaces';
import { getRawSqlite, type Statement } from '@/db/client';
import { getUserSqlite } from '@/db/user-client';
import { emitProgress } from './progress';

const FACE_SAME_PERSON_THRESHOLD = 0.6;
const EMBEDDING_DIM = 128;
const USER_ID = 1;

interface Args {
  threshold: number;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  let threshold = FACE_SAME_PERSON_THRESHOLD;
  let reset = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold') {
      const v = argv[++i]; if (v) threshold = parseFloat(v);
    } else if (a.startsWith('--threshold=')) {
      threshold = parseFloat(a.split('=')[1]);
    } else if (a === '--reset') {
      reset = true;
    }
  }
  return { threshold, reset };
}

interface FaceRow {
  workspaceSlug: string;
  faceId: number;
  embedding: Float32Array;
  personId: number | null;
  confidence: number;
}

function squaredDistance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const diff = a[i] - b[i];
    d += diff * diff;
  }
  return d;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDb = getUserSqlite();

  if (args.reset) {
    console.log('Reset: dropping all person assignments + people rows.');
    for (const ws of listWorkspaces()) {
      getRawSqlite(ws.slug).exec(`UPDATE media_faces SET person_id = NULL`);
    }
    userDb.exec(`DELETE FROM people WHERE user_id = ${USER_ID}`);
  }

  emitProgress({ step: 'Enrich: people', label: 'loading face embeddings' });

  // ── Load every face across every workspace ─────────────────────────
  const faces: FaceRow[] = [];
  for (const ws of listWorkspaces()) {
    const sqlite = getRawSqlite(ws.slug);
    const rows = sqlite.prepare(`
      SELECT mf.id          AS face_id,
             mf.person_id   AS person_id,
             mf.confidence  AS confidence,
             mfe.embedding  AS embedding
      FROM media_faces mf
      JOIN media_face_embeddings mfe ON mfe.rowid = mf.id
    `).all() as Array<{
      face_id: number;
      person_id: number | null;
      confidence: number;
      embedding: Uint8Array;
    }>;
    for (const r of rows) {
      // sqlite-vec stores embeddings as raw little-endian Float32 bytes.
      // Wrap (don't copy) — caller doesn't mutate.
      const emb = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, EMBEDDING_DIM);
      faces.push({
        workspaceSlug: ws.slug,
        faceId: r.face_id,
        embedding: emb,
        personId: r.person_id,
        confidence: r.confidence,
      });
    }
  }

  console.log(`Loaded ${faces.length} face(s) across ${listWorkspaces().length} workspace(s).`);
  emitProgress({
    step: 'Enrich: people',
    current: faces.length,
    total: faces.length,
    label: 'clustering face embeddings',
  });
  if (faces.length === 0) return;

  // ── Union-find ─────────────────────────────────────────────────────
  const parent = new Int32Array(faces.length);
  for (let i = 0; i < faces.length; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const p = parent[x]; parent[x] = r; x = p; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Seed: faces already sharing a person_id stay in the same component.
  // Preserves user labels across re-runs.
  const seedByPerson = new Map<number, number>();
  for (let i = 0; i < faces.length; i++) {
    const pid = faces[i].personId;
    if (pid === null) continue;
    const first = seedByPerson.get(pid);
    if (first === undefined) seedByPerson.set(pid, i);
    else union(first, i);
  }

  // Pairwise — O(n²). Below threshold² avoids one sqrt per pair.
  const thresholdSq = args.threshold * args.threshold;
  const t0 = Date.now();
  for (let i = 0; i < faces.length; i++) {
    if (i % 200 === 0 && i > 0) {
      const pct = ((i / faces.length) * 100).toFixed(1);
      process.stdout.write(`\r  comparing… ${pct}%`);
    }
    for (let j = i + 1; j < faces.length; j++) {
      if (find(i) === find(j)) continue; // already same component
      const d2 = squaredDistance(faces[i].embedding, faces[j].embedding);
      if (d2 < thresholdSq) union(i, j);
    }
  }
  process.stdout.write(`\r  comparing… 100.0% (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

  // ── Collapse to components ─────────────────────────────────────────
  const components = new Map<number, number[]>();
  for (let i = 0; i < faces.length; i++) {
    const r = find(i);
    const arr = components.get(r);
    if (arr) arr.push(i);
    else components.set(r, [i]);
  }

  console.log(`Identified ${components.size} cluster(s).`);

  // ── Resolve person_id per component ─────────────────────────────────
  // If a component contains a face that already has a person_id, reuse
  // that id (smallest wins when multiple — stable, predictable). Else
  // create a new people row.
  const insertPerson = userDb.prepare(`
    INSERT INTO people (uuid, user_id, face_count, cover_face_id, cover_workspace_slug)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `);
  // One prepared UPDATE per workspace — cached by slug to avoid re-prepping
  // inside the inner loop.
  const updateFaceStmts = new Map<string, Statement>();
  const getUpdateFace = (slug: string): Statement => {
    const existing = updateFaceStmts.get(slug);
    if (existing) return existing;
    const stmt = getRawSqlite(slug).prepare(
      'UPDATE media_faces SET person_id = ? WHERE id = ?',
    );
    updateFaceStmts.set(slug, stmt);
    return stmt;
  };

  let newPeople = 0;
  let updatedFaces = 0;

  for (const indices of components.values()) {
    // Pick the smallest existing person_id, if any. Stable tiebreaker.
    let existing: number | null = null;
    for (const fi of indices) {
      const pid = faces[fi].personId;
      if (pid !== null && (existing === null || pid < existing)) existing = pid;
    }

    let personId: number;
    if (existing !== null) {
      personId = existing;
    } else {
      // Cover face = highest detection confidence in the cluster.
      let coverFi = indices[0];
      for (const fi of indices) {
        if (faces[fi].confidence > faces[coverFi].confidence) coverFi = fi;
      }
      const cover = faces[coverFi];
      const res = insertPerson.get(
        crypto.randomUUID(),
        USER_ID,
        indices.length,
        cover.faceId,
        cover.workspaceSlug,
      ) as { id: number };
      personId = res.id;
      newPeople++;
    }

    for (const fi of indices) {
      const face = faces[fi];
      if (face.personId === personId) continue;
      getUpdateFace(face.workspaceSlug).run(personId, face.faceId);
      updatedFaces++;
    }
  }

  // ── Recompute face_count per person across all workspaces ──────────
  // Cluster merges can leave older person rows orphaned (their faces
  // moved to a different person id). Recount + delete zeroes.
  const counts = new Map<number, number>();
  for (const ws of listWorkspaces()) {
    const rows = getRawSqlite(ws.slug).prepare(`
      SELECT person_id AS pid, COUNT(*) AS n FROM media_faces
      WHERE person_id IS NOT NULL
      GROUP BY person_id
    `).all() as Array<{ pid: number; n: number }>;
    for (const r of rows) counts.set(r.pid, (counts.get(r.pid) ?? 0) + r.n);
  }

  const allPeople = userDb.prepare(
    `SELECT id, name FROM people WHERE user_id = ?`,
  ).all(USER_ID) as Array<{ id: number; name: string | null }>;
  const updateCount = userDb.prepare(
    'UPDATE people SET face_count = ?, updated_at = ? WHERE id = ?',
  );
  const deletePerson = userDb.prepare('DELETE FROM people WHERE id = ?');
  let orphanDeleted = 0;
  const now = Date.now();
  for (const p of allPeople) {
    const c = counts.get(p.id) ?? 0;
    if (c === 0) {
      // Be conservative — don't auto-delete labeled people; user might
      // want to keep the row even if its faces moved elsewhere.
      if (p.name === null) {
        deletePerson.run(p.id);
        orphanDeleted++;
      } else {
        updateCount.run(0, now, p.id);
      }
    } else {
      updateCount.run(c, now, p.id);
    }
  }

  console.log(
    `Done. ${newPeople} new person/people · ${updatedFaces} face row(s) updated · ` +
    `${orphanDeleted} orphan row(s) cleaned.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
