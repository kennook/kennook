/**
 * CRUD helpers for media_text_occurrences. Used by every enrichment writer
 * (photo OCR, video frame OCR, whisper transcript) so the table stays
 * consistent. Writers also bump the denormalized rollups on media_items
 * (ocr_text, transcript) — that keeps the existing FTS5 search working
 * unchanged while the new table powers timestamp-aware features.
 */

import type { Sqlite } from '@/db/client';

export type OccurrenceSource = 'ocr' | 'transcript';

export interface OccurrenceInput {
  source: OccurrenceSource;
  /** ms into the timeline; pass `null` for photo OCR. */
  tStartMs: number | null;
  /** End of this occurrence. `null` if not applicable. */
  tEndMs: number | null;
  text: string;
  /** 0..1 confidence reported by the engine. Optional. */
  confidence?: number | null;
}

export interface Occurrence extends OccurrenceInput {
  id: number;
  mediaItemId: number;
  createdAt: number;
}

/**
 * Replace all occurrences for a media item + source. Atomic — wraps in
 * a transaction so a partial failure doesn't leave the row half-empty.
 *
 * Also refreshes the denormalized rollup on media_items (ocr_text or
 * transcript), which is what FTS5 actually searches. Rollup is the
 * deduped newline-join of the inputs.
 */
export function replaceOccurrences(
  sqlite: Sqlite,
  mediaItemId: number,
  source: OccurrenceSource,
  occurrences: OccurrenceInput[],
): void {
  const del = sqlite.prepare(
    `DELETE FROM media_text_occurrences WHERE media_item_id = ? AND source = ?`,
  );
  const ins = sqlite.prepare(
    `INSERT INTO media_text_occurrences
       (media_item_id, source, t_start_ms, t_end_ms, text, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  sqlite.exec('BEGIN');
  try {
    del.run(mediaItemId, source);
    for (const o of occurrences) {
      ins.run(
        mediaItemId,
        o.source,
        o.tStartMs,
        o.tEndMs,
        o.text,
        o.confidence ?? null,
      );
    }
    updateRollup(sqlite, mediaItemId, source, occurrences);
    sqlite.exec('COMMIT');
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Returns every occurrence for an item, optionally filtered by source,
 * ordered by timestamp. Useful for the viewer's "Where it's said"
 * timeline UI in Phase 4.
 */
export function listOccurrencesFor(
  sqlite: Sqlite,
  mediaItemId: number,
  source?: OccurrenceSource,
): Occurrence[] {
  const rows = source
    ? sqlite
        .prepare(
          `SELECT id, media_item_id, source, t_start_ms, t_end_ms, text, confidence, created_at
           FROM media_text_occurrences
           WHERE media_item_id = ? AND source = ?
           ORDER BY t_start_ms IS NULL, t_start_ms`,
        )
        .all(mediaItemId, source)
    : sqlite
        .prepare(
          `SELECT id, media_item_id, source, t_start_ms, t_end_ms, text, confidence, created_at
           FROM media_text_occurrences
           WHERE media_item_id = ?
           ORDER BY t_start_ms IS NULL, t_start_ms`,
        )
        .all(mediaItemId);

  return (rows as Array<{
    id: number;
    media_item_id: number;
    source: OccurrenceSource;
    t_start_ms: number | null;
    t_end_ms: number | null;
    text: string;
    confidence: number | null;
    created_at: number;
  }>).map((r) => ({
    id: r.id,
    mediaItemId: r.media_item_id,
    source: r.source,
    tStartMs: r.t_start_ms,
    tEndMs: r.t_end_ms,
    text: r.text,
    confidence: r.confidence,
    createdAt: r.created_at,
  }));
}

/**
 * Compute the FTS-feeding rollup from a list of occurrences. Deduped
 * (case-insensitive), preserves first-seen order, newline-joined.
 * Returns an empty string when no inputs (so the column gets cleared
 * cleanly instead of holding stale text).
 */
function buildRollup(occurrences: OccurrenceInput[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of occurrences) {
    const t = o.text.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join('\n');
}

function updateRollup(
  sqlite: Sqlite,
  mediaItemId: number,
  source: OccurrenceSource,
  occurrences: OccurrenceInput[],
): void {
  const column = source === 'ocr' ? 'ocr_text' : 'transcript';
  const rolled = buildRollup(occurrences);
  sqlite
    .prepare(`UPDATE media_items SET ${column} = ? WHERE id = ?`)
    .run(rolled.length > 0 ? rolled : null, mediaItemId);
}
