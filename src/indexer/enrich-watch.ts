// Background enrichment daemon.
//
// Polls a workspace for items needing VLM enrichment, processes them in
// batches, and sleeps between cycles. Designed to run detached (nohup, pm2,
// launchd, systemd) — logs to a file so output survives terminal closing.
//
// Usage:
//   pnpm enrich:watch                                    # personal, defaults
//   pnpm enrich:watch --workspace work --interval 60     # named workspace, 60s poll
//   pnpm enrich:watch --batch 10                         # process 10 items per cycle
//   pnpm enrich:watch --include-failed                   # retry previously failed items
//   pnpm enrich:watch --once                             # one cycle then exit (cron-friendly)
//
// To run truly in the background:
//   nohup pnpm enrich:watch > /dev/null 2>&1 &
//   # check the log:  tail -f ~/kennook-app/data/<workspace>/enrich.log
//   # stop with:      pkill -f enrich-watch.ts

import fs from 'node:fs';
import path from 'node:path';
import { getRawSqlite } from '@/db/client';
import { enrichImage } from '@/ai/vlm';
import {
  DEFAULT_WORKSPACE_SLUG,
  resolveWorkspace,
  workspaceRoot,
  type Workspace,
} from '@/server/workspaces';

interface PendingRow {
  id: number;
  uuid: string;
  filename: string;
  thumbnail_path: string | null;
  preview_path: string | null;
}

interface CliArgs {
  workspaceSlug: string;
  intervalSec: number;
  batchSize: number;
  includeFailed: boolean;
  once: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let workspaceSlug = DEFAULT_WORKSPACE_SLUG;
  let intervalSec = 30;
  let batchSize = 5;
  let includeFailed = false;
  let once = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '-w') {
      const v = argv[++i];
      if (!v) throw new Error('--workspace requires a value');
      workspaceSlug = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceSlug = a.split('=')[1];
    } else if (a === '--interval') {
      const v = argv[++i];
      if (!v) throw new Error('--interval requires a value (seconds)');
      intervalSec = parseInt(v, 10);
    } else if (a.startsWith('--interval=')) {
      intervalSec = parseInt(a.split('=')[1], 10);
    } else if (a === '--batch') {
      const v = argv[++i];
      if (!v) throw new Error('--batch requires a value');
      batchSize = parseInt(v, 10);
    } else if (a.startsWith('--batch=')) {
      batchSize = parseInt(a.split('=')[1], 10);
    } else if (a === '--include-failed') {
      includeFailed = true;
    } else if (a === '--once') {
      once = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  pnpm enrich:watch [--workspace <slug>] [--interval <sec>] [--batch <N>]
                    [--include-failed] [--once]
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (intervalSec < 5) throw new Error('--interval must be at least 5 seconds');
  if (batchSize < 1 || batchSize > 50) throw new Error('--batch must be 1–50');
  return { workspaceSlug, intervalSec, batchSize, includeFailed, once };
}

// ─── Logging ─────────────────────────────────────────────────────────────

class Logger {
  private stream: fs.WriteStream;

  constructor(filepath: string) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    this.stream = fs.createWriteStream(filepath, { flags: 'a' });
  }

  log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    this.stream.write(line);
    // Also echo to stdout so foreground runs are useful too.
    process.stdout.write(line);
  }

  close() {
    this.stream.end();
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────

interface Stats {
  enriched: number;
  failed: number;
  cycles: number;
  startedAt: number;
}

async function runOneCycle(
  workspace: Workspace,
  batchSize: number,
  includeFailed: boolean,
  stats: Stats,
  log: Logger,
  shouldStop: () => boolean,
): Promise<{ processed: number; remaining: number }> {
  const sqlite = getRawSqlite(workspace.slug);

  const statusClause = includeFailed
    ? "enrichment_status != 'done'"
    : "enrichment_status = 'pending'";

  const pending = sqlite.prepare(`
    SELECT id, uuid, filename, thumbnail_path, preview_path
    FROM media_items
    WHERE deleted_at IS NULL
      AND ${statusClause}
      AND (thumbnail_path IS NOT NULL OR preview_path IS NOT NULL)
    ORDER BY id
    LIMIT ?
  `).all(batchSize) as unknown as PendingRow[];

  if (pending.length === 0) return { processed: 0, remaining: 0 };

  const remaining = (sqlite.prepare(`
    SELECT COUNT(*) AS n FROM media_items
    WHERE deleted_at IS NULL
      AND ${statusClause}
      AND (thumbnail_path IS NOT NULL OR preview_path IS NOT NULL)
  `).get() as { n: number }).n;

  const updateItem = sqlite.prepare(`
    UPDATE media_items
    SET ai_caption = ?, ocr_text = ?, enrichment_status = 'done', updated_at = ?
    WHERE id = ?
  `);
  const markFailed = sqlite.prepare(`
    UPDATE media_items SET enrichment_status = 'failed', updated_at = ? WHERE id = ?
  `);
  const findOrCreateTag = sqlite.prepare(
    `INSERT INTO tags (user_id, name, source) VALUES (1, ?, 'auto')
     ON CONFLICT(user_id, name) DO UPDATE SET name = excluded.name
     RETURNING id`,
  );
  const linkTag = sqlite.prepare(
    `INSERT OR IGNORE INTO media_tags (media_item_id, tag_id, confidence, source)
     VALUES (?, ?, NULL, 'auto')`,
  );
  const clearOldTags = sqlite.prepare(
    `DELETE FROM media_tags WHERE media_item_id = ? AND source = 'auto'`,
  );

  let processed = 0;

  for (const row of pending) {
    if (shouldStop()) break;

    const imgPath = row.preview_path && fs.existsSync(row.preview_path)
      ? row.preview_path
      : row.thumbnail_path && fs.existsSync(row.thumbnail_path)
        ? row.thumbnail_path
        : null;

    if (!imgPath) {
      markFailed.run(Date.now(), row.id);
      stats.failed++;
      log.log(`SKIP id=${row.id} "${row.filename}" — no thumbnail/preview on disk`);
      continue;
    }

    const itemStart = Date.now();
    try {
      const { caption, ocrText, tags } = await enrichImage(imgPath);
      clearOldTags.run(row.id);
      updateItem.run(caption || null, ocrText || null, Date.now(), row.id);
      for (const tagName of tags) {
        const tagRow = findOrCreateTag.get(tagName) as { id: number } | undefined;
        if (tagRow) linkTag.run(row.id, BigInt(tagRow.id));
      }
      const ms = Date.now() - itemStart;
      stats.enriched++;
      processed++;
      const tagPreview = tags.slice(0, 3).join(', ') + (tags.length > 3 ? '…' : '');
      log.log(`OK   id=${row.id} (${ms}ms) "${row.filename.slice(0, 50)}" [${tagPreview}]`);
    } catch (err) {
      markFailed.run(Date.now(), row.id);
      stats.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      log.log(`FAIL id=${row.id} "${row.filename.slice(0, 50)}" — ${msg}`);
    }
  }

  return { processed, remaining: remaining - processed };
}

function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (shouldStop() || Date.now() - start >= ms) resolve();
      else setTimeout(tick, Math.min(1000, ms - (Date.now() - start)));
    };
    tick();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = resolveWorkspace(args.workspaceSlug);

  const logPath = path.join(workspaceRoot(workspace.slug), 'enrich.log');
  const log = new Logger(logPath);

  let stopRequested = false;
  const shouldStop = () => stopRequested;
  process.on('SIGINT', () => {
    log.log('SIGINT received, finishing current item then stopping…');
    stopRequested = true;
  });
  process.on('SIGTERM', () => {
    log.log('SIGTERM received, finishing current item then stopping…');
    stopRequested = true;
  });

  log.log(`Starting enrich-watch for workspace "${workspace.name}" (${workspace.slug})`);
  log.log(`  interval=${args.intervalSec}s  batch=${args.batchSize}  includeFailed=${args.includeFailed}  once=${args.once}`);
  log.log(`  log file: ${logPath}`);

  const stats: Stats = { enriched: 0, failed: 0, cycles: 0, startedAt: Date.now() };

  while (!stopRequested) {
    stats.cycles++;
    const { processed, remaining } = await runOneCycle(
      workspace, args.batchSize, args.includeFailed, stats, log, shouldStop,
    );

    if (processed > 0) {
      log.log(`Cycle ${stats.cycles}: processed ${processed}, ~${remaining} remaining. Totals: ${stats.enriched} enriched / ${stats.failed} failed.`);
    }

    if (args.once) break;
    if (stopRequested) break;

    // If we just emptied the queue, sleep the full interval; otherwise sleep
    // briefly so we don't hot-loop while there's still work.
    const sleepMs = processed === 0 ? args.intervalSec * 1000 : 1000;
    await sleep(sleepMs, shouldStop);
  }

  const totalSec = ((Date.now() - stats.startedAt) / 1000).toFixed(1);
  log.log(`Stopped. ${stats.cycles} cycle(s), ${stats.enriched} enriched, ${stats.failed} failed, total ${totalSec}s.`);
  log.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
