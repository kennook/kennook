// Shared user-level SQLite database — distinct from per-workspace DBs.
//
// What lives here: anything that spans workspaces (playlists, eventually
// global settings, search history, favorites). Each workspace has its own
// kennook.db; this one is `data/user.db`.

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DATA_ROOT = process.env.KENNOOK_DATA_ROOT ?? './data';
const USER_DB_PATH = path.join(DATA_ROOT, 'user.db');

let _conn: DatabaseSync | null = null;

export function getUserSqlite(): DatabaseSync {
  if (_conn) return _conn;

  if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

  const db = new DatabaseSync(USER_DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);

  initUserSchema(db);
  _conn = db;
  return db;
}

const LATEST_USER_SCHEMA_VERSION = 7;

function initUserSchema(db: DatabaseSync) {
  // Base tables (idempotent — IF NOT EXISTS). For new DBs the column set is
  // already at the latest version; for existing DBs the migrations below
  // bring them forward. Anything that references a versioned column (like
  // an index on user_id) MUST live in a migration step, not here — otherwise
  // it executes against the old schema and throws on existing DBs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid            TEXT NOT NULL UNIQUE,
      user_id         INTEGER NOT NULL DEFAULT 1,
      name            TEXT NOT NULL,
      description     TEXT,
      cover_workspace TEXT,
      cover_item_uuid TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS playlist_items (
      playlist_id    INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      workspace_slug TEXT NOT NULL,
      item_uuid      TEXT NOT NULL,
      position       INTEGER NOT NULL,
      added_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (playlist_id, workspace_slug, item_uuid)
    );
    CREATE INDEX IF NOT EXISTS playlist_items_pos_idx
      ON playlist_items(playlist_id, position);
  `);

  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;

  // v1 → v2: add user_id to existing playlists DBs created before user
  // scoping was a thing, then build the index. Index lives in the migration
  // so it can't fire against an old schema.
  if (version < 2) {
    try { db.exec(`ALTER TABLE playlists ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`); } catch {}
    db.exec(`CREATE INDEX IF NOT EXISTS playlists_user_idx ON playlists(user_id)`);
    version = 2;
  }

  // v2 → v3: generic per-user key/value bag for state that needs to survive
  // reloads but isn't worth its own table. First consumer: the screensaver
  // on/off flag (so reloading the only open tab doesn't dismiss it).
  if (version < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id    INTEGER NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        PRIMARY KEY (user_id, key)
      );
    `);
    version = 3;
  }

  // v3 → v4: people. Cross-workspace because the same person can appear in
  // multiple workspaces; clustering happens here and writes person_id back
  // to each workspace's media_faces. cover_face_id / cover_workspace_slug
  // point at the face that represents this person in the UI (selected by
  // highest detection confidence at cluster time). `name` stays NULL until
  // the user labels them.
  if (version < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid                 TEXT NOT NULL UNIQUE,
        user_id              INTEGER NOT NULL DEFAULT 1,
        name                 TEXT,
        cover_face_id        INTEGER,
        cover_workspace_slug TEXT,
        face_count           INTEGER NOT NULL DEFAULT 0,
        created_at           INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at           INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS people_user_idx ON people(user_id);
    `);
    version = 4;
  }

  // v4 → v5: users table with role-based access control. Two seeded rows
  // by default — id 1 is the "Viewer" (the implicit user every previous
  // version's data hangs off of); id 2 is "Admin" (gates the /admin
  // section). No passwords — the picker at /login just sets a cookie
  // with the chosen user id. Future: replace with proper auth when
  // multi-user/distribution lands.
  if (version < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL CHECK(role IN ('viewer', 'admin')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      INSERT OR IGNORE INTO users (id, name, role) VALUES
        (1, 'Viewer', 'viewer'),
        (2, 'Admin',  'admin');
    `);
    version = 5;
  }

  // v5 → v6: admin_jobs queue. One row per indexer/enrich/backfill run
  // enqueued from /admin/indexing. Status moves queued → running →
  // (completed | failed | canceled). `output` accumulates stdout +
  // stderr lines from the spawned process — kept inline for
  // simplicity (Phase 2); future migration could split to a separate
  // table or file if output gets huge.
  if (version < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_jobs (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        command             TEXT NOT NULL,
        args_json           TEXT NOT NULL DEFAULT '{}',
        workspace_slug      TEXT,
        status              TEXT NOT NULL CHECK(status IN
                              ('queued','running','completed','failed','canceled')),
        output              TEXT NOT NULL DEFAULT '',
        exit_code           INTEGER,
        enqueued_by_user_id INTEGER NOT NULL,
        enqueued_at         INTEGER NOT NULL,
        started_at          INTEGER,
        finished_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS admin_jobs_status_idx
        ON admin_jobs(status, enqueued_at);
    `);
    version = 6;
  }

  // v6 → v7: structured progress on admin_jobs. Scripts emit
  // `@@kennook-progress: <json>` lines on stdout; the runner parses
  // them and stuffs the JSON here. Keeps raw stdout for the log AND
  // a parsed progress object the UI can render as a proper card.
  if (version < 7) {
    try { db.exec(`ALTER TABLE admin_jobs ADD COLUMN progress_json TEXT`); } catch {}
    version = 7;
  }

  if (version !== LATEST_USER_SCHEMA_VERSION) {
    throw new Error(`Unexpected user.db schema version ${version}`);
  }
  db.exec(`PRAGMA user_version = ${LATEST_USER_SCHEMA_VERSION}`);
}
