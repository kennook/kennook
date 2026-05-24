/**
 * /admin/indexing — job catalog + queue + live output panel.
 *
 * Layout (top to bottom):
 *   1. Job catalog — grouped cards by category, click to open the
 *      Run dialog for that job
 *   2. Active + queued — what's running NOW and what's lined up
 *   3. Recent history — last N jobs (any status)
 *   4. Output panel — auto-streams the most recently selected job
 *
 * Polling pattern: the queue list refreshes every 2s via a simple
 * setInterval (covers both new enqueues and status transitions).
 * The output panel uses SSE for the selected job — once a job
 * finishes, its EventSource is closed by the server and we revert
 * to "just show the buffered output" mode.
 */

import { IndexingClient } from '@/components/admin/IndexingClient';

export default function AdminIndexingPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Indexing</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Run scanning, enrichment, and backfill jobs. One job runs at a time —
        enqueue more and they&apos;ll process in order.
      </p>
      <IndexingClient />
    </div>
  );
}
