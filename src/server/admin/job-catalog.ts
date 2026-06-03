/**
 * Catalog of indexer/enrich/backfill scripts exposed via /admin/indexing.
 *
 * The job runner spawns these as child processes via `tsx <script>`.
 * Each entry declares which CLI flags the underlying script accepts —
 * the UI uses this to render a form, and the runner uses it to
 * validate/serialize args before spawning.
 *
 * Keep this list aligned with the package.json `pnpm` scripts. If
 * a new script gets added, register it here too or it won't appear
 * in the catalog UI.
 */

export type JobOptionType = 'library' | 'number' | 'boolean' | 'text';

export interface JobOption {
  /** CLI flag name without the `--` prefix (e.g. 'limit', 'reset').
   *  For positional options this is just an internal identifier — the
   *  runner emits the value at the end of argv without a `--flag` prefix. */
  flag: string;
  type: JobOptionType;
  label: string;
  help?: string;
  defaultValue?: string | number | boolean;
  /** When true, emit the value as a bare positional arg at the end of
   *  argv instead of `--flag value`. Only meaningful for `text` /
   *  `number` types. Multiple positionals are emitted in declaration
   *  order. */
  positional?: boolean;
  /** When true, the run dialog refuses to submit without a value
   *  (empty / undefined). Defaults to false. */
  required?: boolean;
  /** Hint shown as the input's placeholder. */
  placeholder?: string;
}

export interface JobDefinition {
  /** Stable identifier — also the pnpm-script name (e.g. 'enrich:text'). */
  id: string;
  /** Script file path relative to repo root, run via `tsx`. May be null
   *  for aggregates (orchestrated as child `pnpm` commands instead — see
   *  `script` vs `compose` shape below). */
  script: string | null;
  /** For aggregate jobs that orchestrate multiple sub-jobs sequentially
   *  via shell `&&`. When set, runner spawns `pnpm <id>` instead of
   *  spawning `tsx <script>` directly. */
  compose?: boolean;
  label: string;
  description: string;
  category: 'index' | 'backfill' | 'enrich' | 'aggregate' | 'system';
  /** Options the script accepts. `library` always rendered as a
   *  library picker; other types as appropriate inputs. */
  options: JobOption[];
  /** When `true`, this job tends to be long-running (Florence-2 over
   *  thousands of items, etc.); UI surfaces a warning. */
  longRunning?: boolean;
  /** Rough throughput class shown in the run menu when a precise estimate
   *  can't be computed. */
  speed?: 'fast' | 'medium' | 'slow' | 'very-slow';
  /** Rough seconds per item on Apple Silicon, for the "~N min for M items"
   *  estimate. Multiplied by the pending count. Omit for one-shot jobs
   *  (clustering) or jobs whose item count isn't knowable (indexer). */
  secPerItem?: number;
}

export const JOB_CATALOG: JobDefinition[] = [
  {
    id: 'indexer',
    speed: 'medium',
    script: 'src/indexer/index.ts',
    label: 'Indexer',
    description: 'Scan a folder for media files, create database rows, generate thumbnails. Provide either a path to index or enable "retry" to re-process previously-failed files for the chosen library.',
    category: 'index',
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
      {
        flag: 'path', type: 'text', positional: true, label: 'Folder to index',
        help: 'Absolute path to the folder to scan. Leave empty if using Retry.',
        placeholder: '/Users/.../Photos/2026',
      },
      {
        flag: 'retry', type: 'boolean', label: 'Retry previously-failed files',
        help: 'Reads data/<library>/failed-files.json from the last run.',
      },
    ],
  },

  {
    id: 'backfill:vectors',
    speed: 'medium', secPerItem: 0.5,
    script: 'src/indexer/backfill-embeddings.ts',
    label: 'Backfill — Vectors',
    description: 'Generate CLIP/SigLIP embeddings for items missing them. Required for visual search.',
    category: 'backfill',
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
    ],
  },
  {
    id: 'backfill:previews',
    speed: 'medium', secPerItem: 0.3,
    script: 'src/indexer/backfill-previews.ts',
    label: 'Backfill — Previews',
    description: 'Generate 2048px JPEG previews for photos missing them. Required for fullscreen viewing.',
    category: 'backfill',
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
    ],
  },
  {
    id: 'backfill:views',
    speed: 'fast', secPerItem: 0.02,
    script: 'src/indexer/backfill-views.ts',
    label: 'Backfill — Views',
    description: 'Mark items as viewed for the default user based on past interactions (likes, user tags, playlist adds).',
    category: 'backfill',
    options: [
      { flag: 'library', type: 'library', label: 'Library (omit for all)' },
    ],
  },

  {
    id: 'enrich:text',
    speed: 'slow', secPerItem: 3,
    script: 'src/indexer/enrich.ts',
    label: 'Enrich — Text (VLM)',
    description: 'Florence-2 over each item: produces ai_caption, ocr_text, and media_tags. Heaviest enrichment pass.',
    category: 'enrich',
    longRunning: true,
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
      { flag: 'limit', type: 'number', label: 'Limit', help: 'Cap items per run (testing)' },
      { flag: 'force', type: 'boolean', label: 'Force re-enrich items already done' },
    ],
  },
  {
    id: 'enrich:video-text',
    speed: 'very-slow', secPerItem: 30,
    script: 'src/indexer/enrich-video-text.ts',
    label: 'Enrich — Video Text (multi-frame OCR)',
    description: 'Scene-change extraction + Florence-2 OCR across each video. Produces timestamped media_text_occurrences and 256px frame thumbs for "match at 0:45" search results.',
    category: 'enrich',
    longRunning: true,
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
      { flag: 'limit', type: 'number', label: 'Limit', help: 'Cap videos per run (testing)' },
      { flag: 'reset', type: 'boolean', label: 'Re-process every video (drops existing occurrences)' },
      { flag: 'threshold', type: 'number', label: 'Scene threshold', help: 'Default 0.3; higher = fewer frames' },
      { flag: 'max-frames', type: 'number', label: 'Max frames per video', help: 'Default 500; caps very long videos' },
    ],
  },
  {
    id: 'enrich:transcript',
    speed: 'very-slow', secPerItem: 20,
    script: 'src/indexer/enrich-transcript.ts',
    label: 'Enrich — Transcript (audio)',
    description: 'Whisper transcription per video with chunk-level timestamps. Writes media_text_occurrences (source=transcript) and a deduped rollup to media_items.transcript.',
    category: 'enrich',
    longRunning: true,
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
      { flag: 'limit', type: 'number', label: 'Limit', help: 'Cap videos per run (testing)' },
      { flag: 'reset', type: 'boolean', label: 'Re-transcribe every video' },
    ],
  },
  {
    id: 'enrich:transcript-tags',
    speed: 'very-slow', secPerItem: 6,
    script: 'src/indexer/enrich-transcript-tags.ts',
    label: 'Enrich — Transcript Tags (LLM)',
    description: 'Local LLM derives topical tags from each video transcript (media_items.transcript) and writes them to media_tags with source=transcript. Runs after enrich:transcript; reads stored text, no media access needed.',
    category: 'enrich',
    longRunning: true,
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
      { flag: 'limit', type: 'number', label: 'Limit', help: 'Cap transcripts per run (testing)' },
      { flag: 'reset', type: 'boolean', label: 'Re-tag every transcript' },
    ],
  },
  {
    id: 'enrich:faces',
    speed: 'medium', secPerItem: 1,
    script: 'src/indexer/face-enrich.ts',
    label: 'Enrich — Faces',
    description: 'Detect faces and compute 128-d embeddings. Required before clustering (enrich:people).',
    category: 'enrich',
    longRunning: true,
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
      { flag: 'limit', type: 'number', label: 'Limit', help: 'Cap items per run (testing)' },
      { flag: 'reset', type: 'boolean', label: 'Re-process items already done' },
    ],
  },
  {
    id: 'enrich:sensitive',
    speed: 'medium', secPerItem: 0.5,
    script: 'src/indexer/sensitive-enrich.ts',
    label: 'Enrich — Sensitive',
    description: 'Score every photo for NSFW + violence. Continuous [0,1] scores stored on the item.',
    category: 'enrich',
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
      { flag: 'limit', type: 'number', label: 'Limit', help: 'Cap items per run (testing)' },
      { flag: 'reset', type: 'boolean', label: 'Re-score everything' },
    ],
  },
  {
    id: 'enrich:people',
    speed: 'fast',
    script: 'src/indexer/cluster-faces.ts',
    label: 'Enrich — People (Cluster)',
    description: 'Cluster detected face embeddings into people. Run after enrich:faces.',
    category: 'enrich',
    options: [
      { flag: 'threshold', type: 'number', label: 'Threshold', help: 'Default 0.6; lower = tighter clusters' },
      { flag: 'reset', type: 'boolean', label: 'Drop all assignments and re-cluster from scratch' },
    ],
  },

  // Aggregates run via pnpm so the sequential `&&` chain is preserved.
  {
    id: 'enrich:all',
    script: null,
    compose: true,
    label: 'Enrich — All (sequential)',
    description: 'Runs enrich:text → enrich:faces → enrich:sensitive → enrich:people in order. Long-running.',
    category: 'aggregate',
    longRunning: true,
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
    ],
  },
  {
    id: 'backfill:all',
    script: null,
    compose: true,
    label: 'Backfill — All',
    description: 'Runs backfill:vectors → backfill:previews → backfill:views in order.',
    category: 'aggregate',
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
    ],
  },
  {
    id: 'setup',
    script: null,
    compose: true,
    label: 'Setup — Full pipeline',
    description: 'indexer → backfill:all → enrich:all. Use this on a brand-new library.',
    category: 'aggregate',
    longRunning: true,
    options: [
      { flag: 'library', type: 'library', label: 'Library' },
    ],
  },

  // System maintenance. Not library-scoped and intentionally kept out of the
  // per-storage run menu (see estimate.ts) — it's enqueued from the admin
  // update banner, which POSTs `{ command: 'upgrade' }` to /api/admin/jobs.
  {
    id: 'upgrade',
    script: 'scripts/upgrade.ts',
    label: 'Upgrade server',
    description: 'Pull the latest code, install dependencies, and rebuild the production server into a staging dir, then swap it in. Prompts for a manual restart when the build is ready.',
    category: 'system',
    longRunning: true,
    options: [],
  },
];

export function getJobDefinition(id: string): JobDefinition | null {
  return JOB_CATALOG.find((j) => j.id === id) ?? null;
}

// ─── Aggregate expansion ─────────────────────────────────────────────────────
// The admin UI no longer enqueues composite jobs as a single shell-chained
// process. Instead it expands them into discrete steps that the queue runs
// one at a time — so each step is its own visible row (status, progress,
// pause point), and the pipeline is legible in the sidebar.
//
// Order matters: indexer → backfill → enrich, and within enrich, faces must
// precede people (clustering needs the embeddings). The CLI `pnpm enrich:all`
// still runs via run-sequence for terminal use.
export const AGGREGATE_STEPS: Record<string, string[]> = {
  'backfill:all': ['backfill:vectors', 'backfill:previews', 'backfill:views'],
  'enrich:all': [
    'enrich:text', 'enrich:video-text', 'enrich:transcript', 'enrich:transcript-tags',
    'enrich:faces', 'enrich:sensitive', 'enrich:people',
  ],
  'setup': [
    'indexer',
    'backfill:vectors', 'backfill:previews', 'backfill:views',
    'enrich:text', 'enrich:video-text', 'enrich:transcript',
    'enrich:faces', 'enrich:sensitive', 'enrich:people',
  ],
};

/** Expand an aggregate command into its ordered discrete steps. Returns
 *  `[command]` unchanged for non-aggregates. */
export function expandCommand(command: string): string[] {
  return AGGREGATE_STEPS[command] ?? [command];
}
