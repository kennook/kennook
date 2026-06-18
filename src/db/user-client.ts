// Shared user-level SQLite database — distinct from per-library DBs.
//
// What lives here: anything that spans libraries (playlists, eventually
// global settings, search history, favorites). Each library has its own
// kennook.db; this one is `data/user.db`.

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { hashSecret } from '@/server/secret-hash';

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

const LATEST_USER_SCHEMA_VERSION = 12;

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
      cover_library TEXT,
      cover_item_uuid TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS playlist_items (
      playlist_id    INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      library_slug TEXT NOT NULL,
      item_uuid      TEXT NOT NULL,
      position       INTEGER NOT NULL,
      added_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (playlist_id, library_slug, item_uuid)
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

  // v3 → v4: people. Cross-library because the same person can appear in
  // multiple libraries; clustering happens here and writes person_id back
  // to each library's media_faces. cover_face_id / cover_library_slug
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
        cover_library_slug TEXT,
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
        library_slug      TEXT,
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

  // v7 → v8: rename admin_jobs.workspace_slug → library_slug to align with
  // the workspace→library rename. SQLite's RENAME COLUMN is in-place and
  // doesn't touch row contents. Try/catch in case the column was already
  // renamed by an earlier partial run.
  if (version < 8) {
    try { db.exec(`ALTER TABLE admin_jobs RENAME COLUMN workspace_slug TO library_slug`); } catch {}
    version = 8;
  }

  // v8 → v9: finish the workspace→library column rename across user.db.
  // The v8 bump only covered admin_jobs; people, playlists, and playlist_items
  // still had their pre-rename column names, breaking cluster-faces + playlist
  // reads on existing DBs. RENAME COLUMN is in-place and PK-safe.
  if (version < 9) {
    try { db.exec(`ALTER TABLE people         RENAME COLUMN cover_workspace_slug TO cover_library_slug`); } catch {}
    try { db.exec(`ALTER TABLE playlists      RENAME COLUMN cover_workspace      TO cover_library`); } catch {}
    try { db.exec(`ALTER TABLE playlist_items RENAME COLUMN workspace_slug       TO library_slug`); } catch {}
    version = 9;
  }

  // v9 → v10: per-user, per-library saved searches (query + filters + sort,
  // stored as JSON). New DBs run every step, so creating it here covers both.
  if (version < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_searches (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid         TEXT NOT NULL UNIQUE,
        user_id      INTEGER NOT NULL DEFAULT 1,
        library_slug TEXT NOT NULL,
        name         TEXT NOT NULL,
        search_json  TEXT NOT NULL,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS saved_searches_user_lib_idx
        ON saved_searches(user_id, library_slug);
    `);
    version = 10;
  }

  // v10 → v11: per-user login passwords. `password_hash` is nullable — a
  // NULL means "no password" (the account can be selected without one).
  // Seeds STARTER credentials so the app-wide login gate works immediately:
  //   Viewer  → "password"   (the default account everyone lands on)
  //   Admin   → "admin"      (so the gate can't be bypassed by picking the
  //                           passwordless privileged account)
  // Both are intended to be changed in /admin/users. Setting a password on
  // the default Viewer is what flips the whole-app login gate ON, so seeding
  // here deliberately enables it — see server/auth.ts isAuthGateEnabled().
  if (version < 11) {
    try { db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch {}
    const setPw = db.prepare(
      `UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL`,
    );
    setPw.run(hashSecret('password'), 1);
    setPw.run(hashSecret('admin'), 2);
    // Seed the session-signing secret once so both the prod and dev
    // processes sign/verify cookies identically (they share this user.db).
    db.prepare(
      `INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at)
         VALUES (1, 'auth.session_secret', ?, unixepoch() * 1000)`,
    ).run(randomBytes(32).toString('hex'));
    version = 11;
  }

  // v11 → v12: seed a default screensaver-dismiss passphrase ("password") so
  // the walk-away lock is ON out of the box, mirroring the seeded login
  // default. INSERT OR IGNORE never clobbers an admin-chosen value. Clearing
  // it in /admin/settings (empty) means the screensaver dismisses without a
  // password — see server/screensaver-lock.ts.
  if (version < 12) {
    db.prepare(
      `INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at)
         VALUES (1, 'screensaver.lock.hash', ?, unixepoch() * 1000)`,
    ).run(hashSecret('password'));
    version = 12;
  }

  if (version !== LATEST_USER_SCHEMA_VERSION) {
    throw new Error(`Unexpected user.db schema version ${version}`);
  }
  db.exec(`PRAGMA user_version = ${LATEST_USER_SCHEMA_VERSION}`);
}
