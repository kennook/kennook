/**
 * AI workload throttle — lets the operator trade wall-clock time for lower CPU
 * load on the long-running enrichment passes (VLM text, video OCR, transcripts).
 *
 * Two independent levers, both driven by one user-chosen preset stored in
 * `user_settings` (key `config.ai.throttle`):
 *
 *   1. Core cap  — `intraOpNumThreads` passed into every ONNX InferenceSession.
 *      Fewer cores per inference = lower peak load, more cores left free. This
 *      is fixed when a model's session is CREATED, so a change only affects the
 *      NEXT job that starts, not one already running.
 *
 *   2. Duty-cycle pacing — `pace()` sleeps between items in the enrich loops in
 *      proportion to how long the item took. Re-read every item, so a change
 *      takes effect LIVE on the running job. duty=100 → no sleep; duty=50 →
 *      sleep as long as the work took (≈half average load, ≈2× wall-clock).
 *
 * onnxruntime-node grabs ALL cores by default, which is why the untuned passes
 * pin the processor for their whole (multi-hour) run.
 */

import os from 'node:os';
import { getUserSqlite } from '@/db/user-client';

export type ThrottleLevel = 'full' | 'light' | 'background';

export interface ThrottlePreset {
  level: ThrottleLevel;
  label: string;
  /** Cap on cores per inference (0 = ONNX default = all cores). */
  threads: number;
  /** Duty cycle 1–100; <100 sleeps between items to lower average load. */
  duty: number;
  /** Short human blurb for the UI. */
  hint: string;
}

const CORES = Math.max(1, os.cpus().length);

/** Presets scale to the host's core count so they behave sanely anywhere. */
export const THROTTLE_PRESETS: Record<ThrottleLevel, ThrottlePreset> = {
  full: {
    level: 'full',
    label: 'Full speed',
    threads: 0,
    duty: 100,
    hint: `All ${CORES} cores, no pacing — fastest, pins the processor.`,
  },
  light: {
    level: 'light',
    label: 'Light',
    threads: Math.max(1, Math.ceil(CORES / 2)),
    duty: 100,
    hint: `~${Math.max(1, Math.ceil(CORES / 2))} cores — about half the load, ~1.5× slower.`,
  },
  background: {
    level: 'background',
    label: 'Background',
    threads: Math.max(2, Math.ceil(CORES / 3)),
    duty: 50,
    hint: `~${Math.max(2, Math.ceil(CORES / 3))} cores + paced — gentle, machine stays free, ~4× slower.`,
  },
};

const CONFIG_USER_ID = 1;
const SETTINGS_KEY = 'config.ai.throttle';

function isLevel(v: unknown): v is ThrottleLevel {
  return v === 'full' || v === 'light' || v === 'background';
}

/** The current preset, read fresh from user_settings (defaults to full). */
export function getThrottle(): ThrottlePreset {
  try {
    const row = getUserSqlite()
      .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(CONFIG_USER_ID, SETTINGS_KEY) as { value: string | null } | undefined;
    if (isLevel(row?.value)) return THROTTLE_PRESETS[row.value];
  } catch {
    /* DB not ready (e.g. tooling context) — fall through to full. */
  }
  return THROTTLE_PRESETS.full;
}

export function getThrottleLevel(): ThrottleLevel {
  return getThrottle().level;
}

/** Persist a new throttle level. Throws on an unknown level. */
export function setThrottleLevel(level: ThrottleLevel): void {
  if (!isLevel(level)) throw new Error(`Unknown throttle level: ${level}`);
  getUserSqlite().prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, unixepoch() * 1000)
    ON CONFLICT(user_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(CONFIG_USER_ID, SETTINGS_KEY, level);
}

/**
 * ONNX session options for the current throttle — spread into every
 * `from_pretrained` / `pipeline` call. Empty at Full speed (ONNX default).
 * Read ONCE at model-load time, so it reflects the level when the job started.
 */
export function aiSessionOptions(): { session_options?: { intraOpNumThreads: number; interOpNumThreads: number } } {
  const { threads } = getThrottle();
  if (threads <= 0) return {};
  return { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Duty-cycle pause after processing one item. Given how long the item took,
 * sleep enough to hit the configured duty cycle. Re-reads the level each call
 * so UI changes apply live. No-op at duty 100.
 */
export async function pace(elapsedMs: number): Promise<void> {
  const { duty } = getThrottle();
  if (duty >= 100 || elapsedMs <= 0) return;
  const idleMs = Math.round(elapsedMs * (100 / duty - 1));
  if (idleMs > 0) await sleep(idleMs);
}
