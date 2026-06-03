// Per-process pending counts + rough time estimates for the run menu.
// Counts come from each enrichment's status column; rates from the job
// catalog's secPerItem. Aggregates sum their steps.

import type { Sqlite } from '@/db/client';
import { getJobDefinition, expandCommand } from './job-catalog';

/** Pending item count per command for a library. Indexer is omitted —
 *  its workload depends on files on disk, not DB state. */
export function pendingCounts(sqlite: Sqlite): Record<string, number> {
  const one = (sql: string): number => {
    const r = sqlite.prepare(sql).get() as { n: number } | undefined;
    return r?.n ?? 0;
  };
  return {
    'enrich:text': one(`SELECT COUNT(*) AS n FROM media_items
      WHERE enrichment_status='pending' AND deleted_at IS NULL
        AND (thumbnail_path IS NOT NULL OR preview_path IS NOT NULL)`),
    'enrich:video-text': one(`SELECT COUNT(*) AS n FROM media_items
      WHERE kind='video' AND video_text_status='pending' AND deleted_at IS NULL`),
    'enrich:transcript': one(`SELECT COUNT(*) AS n FROM media_items
      WHERE kind='video' AND transcript_status='pending' AND deleted_at IS NULL`),
    'enrich:transcript-tags': one(`SELECT COUNT(*) AS n FROM media_items
      WHERE transcript IS NOT NULL AND transcript != ''
        AND transcript_tags_status='pending' AND deleted_at IS NULL`),
    'enrich:faces': one(`SELECT COUNT(*) AS n FROM media_items
      WHERE kind='photo' AND face_status='pending' AND deleted_at IS NULL`),
    'enrich:sensitive': one(`SELECT COUNT(*) AS n FROM media_items
      WHERE kind='photo' AND sensitive_status='pending' AND deleted_at IS NULL`),
    'backfill:vectors': one(`SELECT COUNT(*) AS n FROM media_items
      WHERE embedding_status='pending' AND deleted_at IS NULL`),
    'backfill:previews': one(`SELECT COUNT(*) AS n FROM media_items
      WHERE kind='photo' AND (preview_path IS NULL OR preview_path='') AND deleted_at IS NULL`),
    'backfill:views': 0, // fast bookkeeping pass; not worth a count
    'enrich:people': 0,  // one-shot clustering over all faces
  };
}

export interface ActionEstimate {
  command: string;
  label: string;
  category: 'index' | 'backfill' | 'enrich' | 'aggregate';
  speed: 'fast' | 'medium' | 'slow' | 'very-slow' | null;
  /** Pending items for a single command; null for aggregates / unknowable. */
  pendingCount: number | null;
  /** Estimated seconds; null when not computable (indexer, one-shot jobs). */
  etaSeconds: number | null;
}

/** Build estimates for the runnable actions (aggregates + individual steps)
 *  for a given library's DB. */
export function buildEstimates(sqlite: Sqlite): ActionEstimate[] {
  const counts = pendingCounts(sqlite);

  const single = (command: string): ActionEstimate | null => {
    const def = getJobDefinition(command);
    if (!def) return null;
    // System jobs (e.g. 'upgrade') aren't library-scoped and never belong in
    // the per-storage run menu. Bailing here also narrows def.category to the
    // run-menu categories below.
    if (def.category === 'system') return null;
    const count = counts[command];
    const eta = def.secPerItem != null && count != null
      ? Math.round(def.secPerItem * count)
      : null;
    return {
      command,
      label: def.label,
      category: def.category,
      speed: def.speed ?? null,
      pendingCount: count ?? null,
      etaSeconds: eta,
    };
  };

  const aggregate = (command: string): ActionEstimate | null => {
    const def = getJobDefinition(command);
    if (!def) return null;
    const steps = expandCommand(command);
    let eta = 0;
    let anyEta = false;
    for (const s of steps) {
      const sd = getJobDefinition(s);
      const c = counts[s];
      if (sd?.secPerItem != null && c != null) { eta += sd.secPerItem * c; anyEta = true; }
    }
    return {
      command,
      label: def.label,
      category: 'aggregate',
      speed: def.speed ?? 'slow',
      pendingCount: null,
      etaSeconds: anyEta ? Math.round(eta) : null,
    };
  };

  const out: ActionEstimate[] = [];
  for (const c of ['indexer', 'backfill:all', 'enrich:all', 'setup']) {
    const e = c === 'indexer' ? single(c) : aggregate(c);
    if (e) out.push(e);
  }
  for (const c of [
    'backfill:vectors', 'backfill:previews', 'backfill:views',
    'enrich:text', 'enrich:video-text', 'enrich:transcript', 'enrich:transcript-tags',
    'enrich:faces', 'enrich:sensitive', 'enrich:people',
  ]) {
    const e = single(c);
    if (e) out.push(e);
  }
  return out;
}
