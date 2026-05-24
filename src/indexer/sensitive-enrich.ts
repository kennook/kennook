// One-shot enrichment: score every photo with sensitive_status='pending'
// against two heuristics — NSFWJS for adult content and CLIP zero-shot
// for violence — and stash the raw scores back on the media_items row.
//
// Both scores stay as continuous [0, 1] values rather than booleans so
// the filter threshold can be tuned at query time without re-indexing.
//
// Photos only — videos are skipped for v1 (representative-frame
// extraction is its own can of worms; will revisit if needed).
//
// Run with:
//   pnpm enrich:sensitive                  # default workspace
//   pnpm enrich:sensitive -w work          # named workspace
//   pnpm enrich:sensitive --reset          # re-score everything
//   pnpm enrich:sensitive --limit 50       # cap for testing

import fs from 'node:fs/promises';
import { DEFAULT_WORKSPACE_SLUG, resolveWorkspace } from '@/server/workspaces';
import { getRawSqlite } from '@/db/client';
import { scoreSensitiveContent } from '@/ai/sensitive';
import { emitProgress } from './progress';

interface Args {
  workspaceSlug: string;
  reset: boolean;
  retryFailed: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  let workspaceSlug = DEFAULT_WORKSPACE_SLUG;
  let reset = false;
  let retryFailed = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '-w') {
      const v = argv[++i]; if (v) workspaceSlug = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceSlug = a.split('=')[1];
    } else if (a === '--reset') {
      reset = true;
    } else if (a === '--retry-failed') {
      retryFailed = true;
    } else if (a === '--limit') {
      const v = argv[++i]; if (v) limit = parseInt(v, 10);
    } else if (a.startsWith('--limit=')) {
      limit = parseInt(a.split('=')[1], 10);
    }
  }
  return { workspaceSlug, reset, retryFailed, limit };
}

interface PendingRow {
  id: number;
  uuid: string;
  filename: string;
  path: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = resolveWorkspace(args.workspaceSlug);
  const sqlite = getRawSqlite(workspace.slug);

  if (args.reset) {
    sqlite.exec(`
      UPDATE media_items
      SET sensitive_status = 'pending', nsfw_score = 0, violence_score = 0
      WHERE kind = 'photo'
    `);
    console.log('Reset sensitive scores for all photos.');
  }

  const limitClause = args.limit ? `LIMIT ${args.limit}` : '';
  // By default we only pick up untouched ('pending') rows. --retry-failed
  // additionally re-runs items whose previous attempt errored — useful
  // when fixing infrastructure issues (e.g., a model URL that was 404'ing)
  // without nuking the already-scored work.
  const statusClause = args.retryFailed
    ? `sensitive_status IN ('pending', 'failed')`
    : `sensitive_status = 'pending'`;
  const pending = sqlite.prepare(`
    SELECT id, uuid, filename, path
    FROM media_items
    WHERE kind = 'photo'
      AND ${statusClause}
      AND deleted_at IS NULL
    ORDER BY id
    ${limitClause}
  `).all() as unknown as PendingRow[];

  console.log(
    `Sensitive enrichment in workspace "${workspace.name}" (${workspace.slug}): ` +
    `${pending.length} photo(s) to process.`,
  );
  if (pending.length === 0) return;

  const update = sqlite.prepare(`
    UPDATE media_items
    SET nsfw_score = ?, violence_score = ?, sensitive_status = ?
    WHERE id = ?
  `);

  let done = 0;
  let failed = 0;
  let flaggedNsfw = 0;
  let flaggedViolence = 0;
  const t0 = Date.now();

  // Heuristic flag thresholds — used only for the per-item progress log.
  // Actual filtering thresholds live next to the filter UI so they can
  // be tuned independently without re-running this script.
  const LOG_NSFW = 0.6;
  const LOG_VIOLENCE = 0.27;

  for (const row of pending) {
    emitProgress({
      step: 'Enrich: sensitive',
      current: done + failed,
      total: pending.length,
      label: 'NSFW + violence scoring',
      currentItem: row.uuid,
      currentItemKind: 'uuid',
      currentItemWorkspace: workspace.slug,
    });
    const idx = `[${done + failed + 1}/${pending.length}]`;
    process.stdout.write(`${idx} ${row.filename} … `);
    try {
      await fs.access(row.path);
    } catch {
      update.run(0, 0, 'failed', row.id);
      failed++;
      console.log('SKIP (file missing)');
      continue;
    }
    try {
      const { nsfw, violence } = await scoreSensitiveContent(row.path);
      update.run(nsfw, violence, 'done', row.id);
      if (nsfw > LOG_NSFW) flaggedNsfw++;
      if (violence > LOG_VIOLENCE) flaggedViolence++;
      done++;
      const flag =
        nsfw > LOG_NSFW || violence > LOG_VIOLENCE
          ? ` ⚑ nsfw=${nsfw.toFixed(2)} violence=${violence.toFixed(2)}`
          : ` (nsfw=${nsfw.toFixed(2)} violence=${violence.toFixed(2)})`;
      console.log(`ok${flag}`);
    } catch (e) {
      update.run(0, 0, 'failed', row.id);
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`FAIL: ${msg}`);
    }
  }
  emitProgress({
    step: 'Enrich: sensitive',
    current: pending.length,
    total: pending.length,
    label: `done — ${done} scored, ${failed} failed`,
  });

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\nDone in ${dt}s — ${done} scored, ${failed} failed. ` +
    `Flagged at default thresholds: ${flaggedNsfw} nsfw, ${flaggedViolence} violence.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
