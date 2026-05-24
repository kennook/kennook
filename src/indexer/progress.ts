/**
 * Tiny helper for indexer/enrich/backfill scripts to emit structured
 * progress that /admin/indexing's UI renders as a proper progress
 * card (instead of just appending to the raw log).
 *
 * Each call writes a single JSON line prefixed with the protocol
 * marker. Scripts can mix `emitProgress` calls with regular
 * console.log output — the runner parses the prefixed lines out and
 * leaves everything else alone.
 *
 * Usage:
 *   emitProgress({ step: 'Indexing', current: i, total: files.length,
 *                  label: 'scanning files', currentItem: filePath,
 *                  currentItemKind: 'path' });
 *
 * Cheap to call — emit on every item or every Nth item, your choice.
 * The UI applies its own throttling for render performance.
 */

import {
  PROGRESS_PREFIX,
  type ProgressPayload,
} from '@/server/admin/progress-protocol';

export function emitProgress(payload: ProgressPayload): void {
  // process.stdout.write to skip console.log's prefixing/buffering.
  // One line per emit; trailing newline so the runner's chunking
  // boundary picks it up promptly.
  try {
    process.stdout.write(`${PROGRESS_PREFIX} ${JSON.stringify(payload)}\n`);
  } catch {
    // stdout closed (e.g. parent killed us mid-write) — nothing to do.
  }
}
