// One-shot backfill: mark items as viewed for the default user when the DB
// already shows clear evidence of past interaction. Bridges the gap between
// pre-watched-feature interactions and the watched/unwatched filter.
//
// Sources of "this counts as viewed":
//   1. A row in media_likes for this user                    (liked)
//   2. A row in media_tags with source = 'user'              (user-tagged)
//   3. The item's uuid appears in playlist_items, scoped to  (added to a
//      this workspace via user.db's playlist_items.workspace_slug    playlist)
//
// Items that were merely *opened* in the viewer pre-feature can't be
// recovered (we never recorded that). Run again any time — INSERT OR
// IGNORE keeps it idempotent.
//
// Run with:
//   pnpm backfill:views                  # all workspaces
//   pnpm backfill:views --workspace work # one workspace

import { getRawSqlite } from '@/db/client';
import { getUserSqlite } from '@/db/user-client';
import { listWorkspaces, resolveWorkspace } from '@/server/workspaces';

const USER_ID = 1;
// Chunk size for the IN-clause used in step 3. SQLite's default
// SQLITE_MAX_VARIABLE_NUMBER is 999; 500 leaves comfortable headroom.
const IN_CLAUSE_CHUNK = 500;

function parseWorkspace(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '-w') {
      const v = argv[++i];
      if (v) return v;
    } else if (a.startsWith('--workspace=')) {
      return a.split('=')[1];
    }
  }
  return null;
}

interface WorkspaceResult {
  slug: string;
  before: number;
  added: number;
  total: number;
  byLike: number;
  byTag: number;
  byPlaylist: number;
}

function countViews(sqlite: ReturnType<typeof getRawSqlite>): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM media_views WHERE user_id = ?')
    .get(USER_ID) as { n: number }).n;
}

function backfillWorkspace(slug: string): WorkspaceResult {
  const sqlite = getRawSqlite(slug);
  const userDb = getUserSqlite();
  const before = countViews(sqlite);

  // 1) Liked items.
  const likeInsert = sqlite.prepare(`
    INSERT OR IGNORE INTO media_views (user_id, media_item_id, viewed_at)
    SELECT user_id, media_item_id, unixepoch() * 1000
    FROM media_likes
    WHERE user_id = ?
  `).run(USER_ID);

  // 2) Items with a user-added tag.
  const tagInsert = sqlite.prepare(`
    INSERT OR IGNORE INTO media_views (user_id, media_item_id, viewed_at)
    SELECT ?, media_item_id, unixepoch() * 1000
    FROM media_tags
    WHERE source = 'user'
  `).run(USER_ID);

  // 3) Items in any playlist that owns them for this workspace.
  // playlist_items lives in user.db; we have to look up the uuids there,
  // then translate to local media_item ids here.
  const playlistRows = userDb.prepare(`
    SELECT DISTINCT pi.item_uuid
    FROM playlist_items pi
    JOIN playlists p ON p.id = pi.playlist_id
    WHERE pi.workspace_slug = ? AND p.user_id = ?
  `).all(slug, USER_ID) as Array<{ item_uuid: string }>;

  let byPlaylist = 0;
  for (let i = 0; i < playlistRows.length; i += IN_CLAUSE_CHUNK) {
    const chunk = playlistRows.slice(i, i + IN_CLAUSE_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const res = sqlite.prepare(`
      INSERT OR IGNORE INTO media_views (user_id, media_item_id, viewed_at)
      SELECT ?, id, unixepoch() * 1000
      FROM media_items
      WHERE uuid IN (${placeholders}) AND deleted_at IS NULL
    `).run(USER_ID, ...chunk.map((r) => r.item_uuid));
    byPlaylist += Number(res.changes);
  }

  const total = countViews(sqlite);
  return {
    slug,
    before,
    added: total - before,
    total,
    byLike: Number(likeInsert.changes),
    byTag: Number(tagInsert.changes),
    byPlaylist,
  };
}

async function main() {
  const onlyOne = parseWorkspace(process.argv.slice(2));
  const targets = onlyOne ? [resolveWorkspace(onlyOne)] : listWorkspaces();

  console.log(`Backfilling media_views for user_id=${USER_ID} across ${targets.length} workspace(s)…\n`);

  let totalAdded = 0;
  for (const ws of targets) {
    const r = backfillWorkspace(ws.slug);
    totalAdded += r.added;
    // Per-source counts may sum to more than `added` because the same item
    // can hit multiple sources (e.g. liked AND in a playlist); INSERT OR
    // IGNORE collapses them. That's expected — `added` is the truth.
    console.log(
      `[${ws.slug}] +${r.added} new (${r.total} total) ` +
      `· likes:${r.byLike} tags:${r.byTag} playlists:${r.byPlaylist}`,
    );
  }

  console.log(`\nDone. Marked ${totalAdded} item(s) as viewed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
