import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import {
  DEFAULT_LIBRARY_SLUG,
  resolveLibrary,
  libraryDbPath,
  libraryThumbnailsDir,
} from '@/server/libraries';

export type Sqlite = DatabaseSync;
export type Statement = StatementSync;

// One cached DatabaseSync per library slug. Each library has an entirely
// separate SQLite file under data/<slug>/kennook.db, so we open and cache one
// connection per library and reuse it for the process lifetime.
const _connections = new Map<string, DatabaseSync>();

export function getRawSqlite(librarySlug: string = DEFAULT_LIBRARY_SLUG): DatabaseSync {
  const ws = resolveLibrary(librarySlug);
  const slug = ws.slug;

  const existing = _connections.get(slug);
  if (existing) return existing;

  const dbPath = libraryDbPath(slug);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(libraryThumbnailsDir(slug))) {
    fs.mkdirSync(libraryThumbnailsDir(slug), { recursive: true });
  }

  const sqlite = new DatabaseSync(dbPath, { allowExtension: true });
  sqlite.loadExtension(sqliteVec.getLoadablePath());

  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);

  // Deterministic per-(id, seed) hash for the shuffle sort (ORDER BY
  // shuffle_key(m.id, seed)). A murmur-style avalanche: different seeds give
  // genuinely different orders (not rotations of one another), and adjacent ids
  // don't land adjacently — which a plain `(id*prime+seed) % p` can't do in
  // SQLite (no XOR operator, no intermediate vars). Returns a 31-bit int.
  sqlite.function('shuffle_key', { deterministic: true }, (id, seed) => {
    let h = (Number(id) ^ Number(seed)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h & 0x7fffffff;
  });

  initSchema(sqlite);
  applyMigrations(sqlite);
  _connections.set(slug, sqlite);
  return sqlite;
}

// Versioned migrations. Each step bumps PRAGMA user_version after running so
// it's idempotent. To add a new migration: append a new branch, bump LATEST.
const LATEST_SCHEMA_VERSION = 17;

function applyMigrations(sqlite: DatabaseSync) {
  // Try/catch column additions are kept around for DBs created before we
  // started using user_version. New work should use versioned branches below.
  const earlyAdditions = [
    'ALTER TABLE media_items ADD COLUMN preview_path TEXT',
  ];
  for (const stmt of earlyAdditions) {
    try { sqlite.exec(stmt); } catch { /* column exists */ }
  }

  const row = sqlite.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;

  // ── v1: VLM enrichment — ocr_text + tags + media_tags + FTS rebuild ─────
  if (version < 1) {
    try { sqlite.exec('ALTER TABLE media_items ADD COLUMN ocr_text TEXT'); } catch {}

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        name        TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        UNIQUE(user_id, name)
      );
      CREATE INDEX IF NOT EXISTS tags_name_idx ON tags(name);

      CREATE TABLE IF NOT EXISTS media_tags (
        media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        confidence    REAL,
        PRIMARY KEY (media_item_id, tag_id)
      );
      CREATE INDEX IF NOT EXISTS media_tags_tag_idx ON media_tags(tag_id);
    `);

    // FTS5 column set is fixed at create time, so we drop and recreate. The
    // table is just an index — content lives in media_items — so this is a
    // cheap rebuild from scratch.
    sqlite.exec(`
      DROP TRIGGER IF EXISTS media_fts_ins;
      DROP TRIGGER IF EXISTS media_fts_del;
      DROP TRIGGER IF EXISTS media_fts_upd;
      DROP TABLE IF EXISTS media_fts;

      CREATE VIRTUAL TABLE media_fts USING fts5(
        filename, caption, summary, transcript, place, ocr_text,
        content='media_items',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER media_fts_ins AFTER INSERT ON media_items BEGIN
        INSERT INTO media_fts(rowid, filename, caption, summary, transcript, place, ocr_text)
        VALUES (new.id, new.filename, new.ai_caption, new.ai_summary,
                new.transcript, new.captured_place, new.ocr_text);
      END;

      CREATE TRIGGER media_fts_del AFTER DELETE ON media_items BEGIN
        INSERT INTO media_fts(media_fts, rowid, filename, caption, summary, transcript, place, ocr_text)
        VALUES('delete', old.id, old.filename, old.ai_caption, old.ai_summary,
               old.transcript, old.captured_place, old.ocr_text);
      END;

      CREATE TRIGGER media_fts_upd AFTER UPDATE ON media_items BEGIN
        INSERT INTO media_fts(media_fts, rowid, filename, caption, summary, transcript, place, ocr_text)
        VALUES('delete', old.id, old.filename, old.ai_caption, old.ai_summary,
               old.transcript, old.captured_place, old.ocr_text);
        INSERT INTO media_fts(rowid, filename, caption, summary, transcript, place, ocr_text)
        VALUES (new.id, new.filename, new.ai_caption, new.ai_summary,
                new.transcript, new.captured_place, new.ocr_text);
      END;
    `);

    // Backfill the rebuilt FTS index from existing rows.
    sqlite.exec(`
      INSERT INTO media_fts(rowid, filename, caption, summary, transcript, place, ocr_text)
      SELECT id, filename, ai_caption, ai_summary, transcript, captured_place, ocr_text
      FROM media_items
      WHERE deleted_at IS NULL;
    `);

    version = 1;
  }

  // ── v2: enrichment status column (so enrich CLI knows what's pending) ───
  if (version < 2) {
    try { sqlite.exec(`ALTER TABLE media_items ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending'`); } catch {}
    version = 2;
  }

  // ── v3: per-item like count (0–MAX_LIKES). Acts as a click-to-rate. ─────
  if (version < 3) {
    try { sqlite.exec(`ALTER TABLE media_items ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0`); } catch {}
    sqlite.exec(`CREATE INDEX IF NOT EXISTS media_like_count_idx ON media_items(like_count) WHERE like_count > 0`);
    version = 3;
  }

  // ── v4: user-scoped likes table. The v3 like_count column is shared
  // across all users (wrong for the eventual multi-user world). We migrate
  // existing values into media_likes under user_id=1 and drop the column.
  if (version < 4) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS media_likes (
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        media_item_id  INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        count          INTEGER NOT NULL CHECK (count > 0 AND count <= 5),
        updated_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        PRIMARY KEY (user_id, media_item_id)
      );
      CREATE INDEX IF NOT EXISTS media_likes_user_count_idx
        ON media_likes(user_id, count);
    `);
    // Backfill any existing v3 likes into v4 under the implicit single user.
    try {
      sqlite.exec(`
        INSERT OR IGNORE INTO media_likes (user_id, media_item_id, count, updated_at)
        SELECT 1, id, like_count, unixepoch() * 1000
        FROM media_items
        WHERE like_count > 0;
      `);
      // SQLite ≥3.35 supports DROP COLUMN. The bundled SQLite in Node 22+ is
      // well past that, so this is safe.
      sqlite.exec('DROP INDEX IF EXISTS media_like_count_idx');
      sqlite.exec('ALTER TABLE media_items DROP COLUMN like_count');
    } catch {
      // If the source column never existed (fresh DB), nothing to migrate.
    }
    version = 4;
  }

  // ── v5: track whether each media_tags link came from auto-enrichment or
  // was added by the user. User-added tags survive re-enrichment.
  if (version < 5) {
    try { sqlite.exec(`ALTER TABLE media_tags ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'`); } catch {}
    version = 5;
  }

  // ── v6: per-user "viewed" record. Any interaction with an item (opening
  // it in the viewer, liking, tagging, adding to a playlist) upserts a row
  // here. Drives the watched/unwatched filter in the sidebar.
  if (version < 6) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS media_views (
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        media_item_id  INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        viewed_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        PRIMARY KEY (user_id, media_item_id)
      );
      CREATE INDEX IF NOT EXISTS media_views_user_idx ON media_views(user_id);
    `);
    version = 6;
  }

  // ── v7: per-item face detections + 128-d embeddings.
  // One row per face in `media_faces` (bbox + confidence + a nullable
  // person_id assigned later by clustering / a user). Embeddings live in a
  // vec0 virtual table keyed by media_faces.id, mirroring the existing
  // media_embeddings setup so nearest-neighbour search works the same way.
  // `face_status` on media_items lets the enrichment CLI skip rows that
  // have already been processed (states: pending / done / failed / no-faces).
  if (version < 7) {
    try { sqlite.exec(`ALTER TABLE media_items ADD COLUMN face_status TEXT NOT NULL DEFAULT 'pending'`); } catch {}
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS media_faces (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        media_item_id  INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        bbox_x         INTEGER NOT NULL,
        bbox_y         INTEGER NOT NULL,
        bbox_w         INTEGER NOT NULL,
        bbox_h         INTEGER NOT NULL,
        confidence     REAL,
        person_id      INTEGER,
        created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS media_faces_item_idx ON media_faces(media_item_id);
      CREATE INDEX IF NOT EXISTS media_faces_person_idx
        ON media_faces(person_id) WHERE person_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS media_face_status_idx
        ON media_items(face_status) WHERE face_status = 'pending';

      CREATE VIRTUAL TABLE IF NOT EXISTS media_face_embeddings USING vec0(
        embedding FLOAT[128]
      );
    `);
    version = 7;
  }

  // ── v8: client-applied rotation override for photos.
  // Stored as degrees (0/90/180/270). EXIF orientation is already honored
  // at indexer time; this column is the user's *additional* correction
  // for photos that still come out sideways. Applied via CSS transform on
  // render — files aren't modified, thumbnails aren't regenerated.
  if (version < 8) {
    try {
      sqlite.exec(`ALTER TABLE media_items ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column exists */ }
    version = 8;
  }

  // ── v9: sensitive-content scores. Two heuristics per photo:
  //   nsfw_score     — adult/explicit, via NSFWJS (MobileNetV2). 0–1.
  //   violence_score — gore/weapons/fight, via CLIP zero-shot prompts. 0–1.
  // sensitive_status mirrors face_status (pending / done / failed). Filters
  // are threshold-based so the cutoff can be tuned in code without
  // re-indexing.
  if (version < 9) {
    try { sqlite.exec(`ALTER TABLE media_items ADD COLUMN nsfw_score REAL NOT NULL DEFAULT 0`); } catch {}
    try { sqlite.exec(`ALTER TABLE media_items ADD COLUMN violence_score REAL NOT NULL DEFAULT 0`); } catch {}
    try { sqlite.exec(`ALTER TABLE media_items ADD COLUMN sensitive_status TEXT NOT NULL DEFAULT 'pending'`); } catch {}
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS media_sensitive_status_idx
        ON media_items(sensitive_status) WHERE sensitive_status = 'pending';
    `);
    version = 9;
  }

  // ── v10: media_items.path becomes RELATIVE to storage_locations.config.root_path.
  // Pre-v10 we stored absolute paths and storage config was {"root":"/"}. We
  // keep root_path="/" here so the join (root + path) reproduces the original
  // absolute path bit-for-bit — the schema gets its new shape without any
  // semantic change. The forthcoming Storage admin UI is where users will
  // tighten root_path to a specific drive/folder (and the existing paths get
  // re-relativized at that point).
  if (version < 10) {
    const locs = sqlite
      .prepare(`SELECT id, config FROM storage_locations`)
      .all() as { id: number; config: string }[];

    for (const loc of locs) {
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse(loc.config) as Record<string, unknown>; } catch { /* malformed */ }
      if (typeof cfg.root_path === 'string') continue; // already migrated

      const newCfg: Record<string, unknown> = { ...cfg, root_path: '/' };
      delete newCfg.root;
      sqlite
        .prepare(`UPDATE storage_locations SET config = ? WHERE id = ?`)
        .run(JSON.stringify(newCfg), loc.id);
    }

    // Strip leading "/" from every absolute path (idempotent — rows that
    // already lack a leading slash are untouched).
    sqlite.exec(`
      UPDATE media_items
      SET path = substr(path, 2)
      WHERE substr(path, 1, 1) = '/'
    `);

    version = 10;
  }

  // ── v11: track when each storage_location was last indexed. Driven by
  // the job runner — completes an `indexer` job → bumps the matching
  // storage's last_indexed_at. UI shows it as a relative timestamp so
  // operators can tell which folders are due for a re-scan.
  if (version < 11) {
    try { sqlite.exec(`ALTER TABLE storage_locations ADD COLUMN last_indexed_at INTEGER`); } catch {}
    version = 11;
  }

  // ── v12: timestamped text occurrences (OCR + transcript). The existing
  // media_items.ocr_text / .transcript columns stay as denormalized rollups
  // (newline-joined, deduped) so FTS5 keeps matching unchanged. The new
  // media_text_occurrences table keeps per-frame / per-segment timestamps so
  // search results can deep-link to "match at 1:23".
  //
  // Adds video_text_status to media_items to track multi-frame OCR progress
  // per video. Existing videos start as 'pending' so the new enrich job
  // picks them up; photos default 'n/a' since their text is already in
  // a single occurrence at t_start_ms=NULL.
  if (version < 12) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS media_text_occurrences (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        media_item_id   INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        source          TEXT NOT NULL CHECK(source IN ('ocr', 'transcript')),
        /* ms into the timeline; NULL for photo OCR (no timeline). */
        t_start_ms      INTEGER,
        /* End of this occurrence: next scene change for OCR, segment end
           for whisper. NULL when not applicable. */
        t_end_ms        INTEGER,
        text            TEXT NOT NULL,
        /* 0..1 confidence reported by the OCR / transcript engine. */
        confidence      REAL,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS media_text_occ_item_idx
        ON media_text_occurrences(media_item_id);
      CREATE INDEX IF NOT EXISTS media_text_occ_source_idx
        ON media_text_occurrences(media_item_id, source);
    `);

    try {
      sqlite.exec(`ALTER TABLE media_items ADD COLUMN video_text_status TEXT NOT NULL DEFAULT 'pending'`);
    } catch { /* column exists */ }

    // Photos don't have a timeline → mark them as not-applicable so the
    // video-text enrich job skips them in its WHERE clause.
    sqlite.exec(`
      UPDATE media_items
      SET video_text_status = 'n/a'
      WHERE kind = 'photo' AND video_text_status = 'pending'
    `);

    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS media_video_text_status_idx
        ON media_items(video_text_status)
        WHERE video_text_status = 'pending'
    `);

    version = 12;
  }

  // ── v13: per-video audio transcription status. Mirrors video_text_status
  // but for the Whisper pipeline. Photos → 'n/a' (no audio). Existing videos
  // → 'pending' so the new enrich:transcript job picks them up.
  if (version < 13) {
    try {
      sqlite.exec(`ALTER TABLE media_items ADD COLUMN transcript_status TEXT NOT NULL DEFAULT 'pending'`);
    } catch { /* column exists */ }
    sqlite.exec(`
      UPDATE media_items
      SET transcript_status = 'n/a'
      WHERE kind = 'photo' AND transcript_status = 'pending'
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS media_transcript_status_idx
        ON media_items(transcript_status)
        WHERE transcript_status = 'pending'
    `);
    version = 13;
  }

  // ── v14: LLM transcript tagging — per-item status so it's resumable and
  //         re-runnable independently of the transcription pass. ───────────
  if (version < 14) {
    try {
      sqlite.exec(`ALTER TABLE media_items ADD COLUMN transcript_tags_status TEXT NOT NULL DEFAULT 'pending'`);
    } catch { /* column exists */ }
    // Photos never have a transcript; mark them n/a so they're obviously out
    // of scope (the tagger also gates on a non-empty transcript, so this is
    // cosmetic — kept parallel to transcript_status for consistency).
    sqlite.exec(`
      UPDATE media_items
      SET transcript_tags_status = 'n/a'
      WHERE kind = 'photo' AND transcript_tags_status = 'pending'
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS media_transcript_tags_status_idx
        ON media_items(transcript_tags_status)
        WHERE transcript_tags_status = 'pending'
    `);
    version = 14;
  }

  // ── v15: capture video bit-rate + codec from ffprobe going forward ──────
  // Nullable, no backfill — existing rows stay NULL; only files indexed after
  // this point populate them. The resolution-based "quality" facet derives
  // from width/height and needs neither column, so it works on old rows too.
  if (version < 15) {
    try { sqlite.exec('ALTER TABLE media_items ADD COLUMN video_bitrate INTEGER'); } catch { /* column exists */ }
    try { sqlite.exec('ALTER TABLE media_items ADD COLUMN video_codec TEXT'); } catch { /* column exists */ }
    version = 15;
  }

  // ── v16: by-item indexes for the "most liked (everyone)" + "most viewed"
  // sorts. Existing indexes lead with user_id (media_likes PK / media_views_
  // user_idx), so the SUM/COUNT-by-media_item_id sort subqueries would table-
  // scan per row without these.
  if (version < 16) {
    sqlite.exec('CREATE INDEX IF NOT EXISTS media_likes_item_idx ON media_likes(media_item_id)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS media_views_item_idx ON media_views(media_item_id)');
    version = 16;
  }

  // ── v17: manual sensitivity override. Tri-state: NULL = use auto-detection
  // (nsfw_score/violence_score vs thresholds), 1 = forced sensitive, 0 = forced
  // safe. Separate from the auto scores so enrich:sensitive never clobbers it.
  if (version < 17) {
    try { sqlite.exec('ALTER TABLE media_items ADD COLUMN sensitive_override INTEGER'); } catch { /* column exists */ }
    version = 17;
  }

  if (version !== LATEST_SCHEMA_VERSION) {
    // Defensive: refuse to run on an unknown future schema.
    throw new Error(`Unexpected schema version ${version} (expected ${LATEST_SCHEMA_VERSION})`);
  }
  sqlite.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
}

function initSchema(sqlite: DatabaseSync) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      settings TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_uuid_idx ON users(uuid);

    CREATE TABLE IF NOT EXISTS storage_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      storage_location_id INTEGER NOT NULL REFERENCES storage_locations(id),
      path TEXT NOT NULL,
      filename TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      sha256 TEXT,
      phash TEXT,
      captured_at INTEGER,
      captured_lat REAL,
      captured_lon REAL,
      captured_place TEXT,
      camera_make TEXT,
      camera_model TEXT,
      ai_caption TEXT,
      ai_summary TEXT,
      transcript TEXT,
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      video_text_status TEXT NOT NULL DEFAULT 'pending',
      transcript_status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT,
      thumbnail_path TEXT,
      preview_path TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      deleted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_uuid_idx       ON media_items(uuid);
    CREATE INDEX        IF NOT EXISTS media_user_idx       ON media_items(user_id);
    CREATE INDEX        IF NOT EXISTS media_kind_idx       ON media_items(kind);
    CREATE INDEX        IF NOT EXISTS media_captured_idx   ON media_items(captured_at);
    CREATE INDEX        IF NOT EXISTS media_sha256_idx     ON media_items(sha256);

    CREATE TABLE IF NOT EXISTS media_text_occurrences (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      media_item_id   INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source          TEXT NOT NULL CHECK(source IN ('ocr', 'transcript')),
      t_start_ms      INTEGER,
      t_end_ms        INTEGER,
      text            TEXT NOT NULL,
      confidence      REAL,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS media_text_occ_item_idx   ON media_text_occurrences(media_item_id);
    CREATE INDEX IF NOT EXISTS media_text_occ_source_idx ON media_text_occurrences(media_item_id, source);

    CREATE VIRTUAL TABLE IF NOT EXISTS media_embeddings USING vec0(
      embedding FLOAT[512]
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
      filename, caption, summary, transcript, place,
      content='media_items',
      content_rowid='id',
      tokenize='porter unicode61'
    );
  `);

  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS media_fts_ins AFTER INSERT ON media_items BEGIN
      INSERT INTO media_fts(rowid, filename, caption, summary, transcript, place)
      VALUES (new.id, new.filename, new.ai_caption, new.ai_summary, new.transcript, new.captured_place);
    END;

    CREATE TRIGGER IF NOT EXISTS media_fts_del AFTER DELETE ON media_items BEGIN
      INSERT INTO media_fts(media_fts, rowid, filename, caption, summary, transcript, place)
      VALUES('delete', old.id, old.filename, old.ai_caption, old.ai_summary, old.transcript, old.captured_place);
    END;

    CREATE TRIGGER IF NOT EXISTS media_fts_upd AFTER UPDATE ON media_items BEGIN
      INSERT INTO media_fts(media_fts, rowid, filename, caption, summary, transcript, place)
      VALUES('delete', old.id, old.filename, old.ai_caption, old.ai_summary, old.transcript, old.captured_place);
      INSERT INTO media_fts(rowid, filename, caption, summary, transcript, place)
      VALUES (new.id, new.filename, new.ai_caption, new.ai_summary, new.transcript, new.captured_place);
    END;
  `);

  seedDefaults(sqlite);
}

function seedDefaults(sqlite: DatabaseSync) {
  // Single-user v0.1 seed. We deliberately do NOT seed a default
  // storage_location anymore — each library must have at least one
  // user-chosen folder before it can index anything, so the library
  // creation flow takes responsibility for inserting the first row.
  const userExists = sqlite.prepare('SELECT 1 FROM users WHERE id = 1').get();
  if (!userExists) {
    sqlite
      .prepare(`INSERT INTO users (id, uuid, display_name) VALUES (1, ?, 'You')`)
      .run(crypto.randomUUID());
  }
}
