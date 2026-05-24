/**
 * Structured progress protocol for admin jobs.
 *
 * Scripts emit a single line per progress update:
 *
 *   @@kennook-progress: {"step":"Indexing","current":42,"total":100,...}
 *
 * The job runner watches stdout for this magic prefix, parses the
 * JSON, stores the latest snapshot on the job row, and emits a
 * `progress` SSE event for live UI updates. Lines that DON'T match
 * pass through to the raw output log unchanged, so scripts can mix
 * normal logging with progress signals.
 *
 * Shared between client (UI rendering) and server (parsing) — keep
 * pure-data only, no imports.
 */

export const PROGRESS_PREFIX = '@@kennook-progress:';

export interface ProgressPayload {
  /** Short label for the current phase, e.g. "Indexing", "Enrich:
   *  faces". Shown as a chip in the UI. */
  step: string;
  /** Aggregate position, when known. e.g. step 2 of 3 in `setup`. */
  stepIndex?: number;
  stepTotal?: number;
  /** Items processed so far in this step. */
  current?: number;
  /** Total items planned for this step. Undefined when unknown
   *  (scripts that don't pre-count). */
  total?: number;
  /** Single-line description of what's happening right now, e.g.
   *  "embedding image", "detecting faces". */
  label?: string;
  /** Identifier of the item currently being processed. For media
   *  items, prefer the uuid so the UI can fetch a thumbnail via
   *  /api/thumbnails/<uuid>. For pre-DB files (indexer), the path.
   *  When `currentItemKind === 'uuid'`, the UI shows a thumbnail. */
  currentItem?: string;
  currentItemKind?: 'uuid' | 'path';
  /** Workspace this item belongs to — needed for thumbnail URLs
   *  since they're per-workspace. */
  currentItemWorkspace?: string;
}

/**
 * A previously-processed item, kept in a small rolling buffer so the
 * UI can render a strip of recently-scanned thumbnails alongside the
 * current one. Maintained server-side by the runner — scripts only
 * emit `ProgressPayload`; promotion to `RecentItem` happens when the
 * next emit arrives (signaling that the previous item finished).
 */
export interface RecentItem {
  item: string;
  kind: 'uuid' | 'path';
  workspace?: string;
  /** Optional caption — usually the step's label at the time it was
   *  processed, e.g. "captioning + OCR + tagging". */
  label?: string;
  /** When the item was promoted into the buffer (≈ when it finished). */
  at: number;
}

/** Wire shape for the SSE `progress` event — combines the latest
 *  progress emit with the runner-maintained rolling buffer of recent
 *  items so a single message refreshes both the "now scanning" tile
 *  and the strip. */
export interface ProgressEnvelope {
  progress: ProgressPayload;
  recent: RecentItem[];
}

/**
 * Extract a progress payload from a stdout line, if any. Returns
 * null for lines that don't match the protocol (the common case).
 */
export function parseProgressLine(line: string): ProgressPayload | null {
  const idx = line.indexOf(PROGRESS_PREFIX);
  if (idx === -1) return null;
  const rest = line.slice(idx + PROGRESS_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(rest) as ProgressPayload;
    if (parsed && typeof parsed.step === 'string') return parsed;
  } catch { /* malformed JSON — silently skip, don't crash the runner */ }
  return null;
}
