/**
 * Sensitive-content heuristics. Two independent signals per image:
 *
 *   nsfw_score      — NSFWJS (MobileNetV2). Five-way classifier; we
 *                     aggregate to a single 0–1 "this looks adult"
 *                     probability = porn + hentai + sexy.
 *   violence_score  — CLIP zero-shot against a small bank of violence-
 *                     adjacent text prompts. Reuses the existing
 *                     SigLIP/CLIP image+text embedder so there's no
 *                     extra model to load. Genuinely noisy — confuses
 *                     video-game stills / news photos / movie shots
 *                     for actual violence. Use as a hint, not truth.
 *
 * Both functions lazily load their models on first call and cache for
 * the process lifetime.
 */

import sharp from 'sharp';
// Polyfill + tfjs-node first, then nsfwjs (which expects the native
// backend to be registered).
import './tfjs-node-polyfill';
import * as tf from '@tensorflow/tfjs-node';
import * as nsfwjs from 'nsfwjs';
import { embedImage, embedText } from './embeddings';

// ── NSFW detection ──────────────────────────────────────────────────

// NSFWJS ≥ 3.x bundles its MobileNetV2 weights inside the npm package
// itself, so we don't need to fetch model files from any CDN. The
// argument-less `load()` call resolves to the bundled MobileNetV2.

let nsfwModel: nsfwjs.NSFWJS | null = null;
let nsfwLoadPromise: Promise<void> | null = null;
async function ensureNsfwLoaded(): Promise<void> {
  if (nsfwModel) return;
  if (nsfwLoadPromise) { await nsfwLoadPromise; return; }
  nsfwLoadPromise = (async () => {
    await tf.ready();
    nsfwModel = await nsfwjs.load();
  })();
  await nsfwLoadPromise;
}

// MobileNetV2's native input is 224×224. We let sharp do the
// downscale rather than relying on NSFWJS's internal resize so we
// also dodge HEIC/large-image decode pitfalls.
const NSFW_INPUT_SIZE = 224;

/**
 * Score an image's NSFW probability in [0, 1]. Failure modes return 0
 * — better to under-flag than throw and break the whole batch.
 */
export async function nsfwScore(imagePath: string): Promise<number> {
  await ensureNsfwLoaded();
  if (!nsfwModel) return 0;

  let tensor: tf.Tensor3D | null = null;
  try {
    const { data, info } = await sharp(imagePath, { failOn: 'none' })
      .rotate()
      .resize(NSFW_INPUT_SIZE, NSFW_INPUT_SIZE, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
    const predictions = await nsfwModel.classify(tensor);

    let score = 0;
    for (const p of predictions) {
      const cls = p.className.toLowerCase();
      // Drawing covers hentai-style line art; we treat hentai as adult,
      // but plain "drawing" stays neutral (otherwise comics/art trip it).
      if (cls === 'porn' || cls === 'hentai' || cls === 'sexy') {
        score += p.probability;
      }
    }
    return Math.min(1, score);
  } catch {
    return 0;
  } finally {
    tensor?.dispose();
  }
}

// ── Violence / gore via CLIP zero-shot ──────────────────────────────

/**
 * Prompts used to probe for violence-related content. Aggregated by
 * taking the max cosine similarity across the bank — a single strong
 * match is enough to flag, since most violence imagery only matches
 * one or two concepts. Keep this list small and concrete; broader
 * abstractions ("scary", "dark") drift into too many false positives.
 */
const VIOLENCE_PROMPTS = [
  'a photo of violence, a person being hurt',
  'a bloody wound, gore',
  'a person holding a weapon, a gun or knife pointed',
  'a fight scene with physical injury',
];

// Cosine similarity of two unit-norm vectors. CLIP/SigLIP embeddings
// are L2-normalized at extraction time, so dot product == cosine sim.
function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

let violenceTextEmbeddings: Float32Array[] | null = null;
let violenceLoadPromise: Promise<void> | null = null;
async function ensureViolencePromptsEmbedded(): Promise<void> {
  if (violenceTextEmbeddings) return;
  if (violenceLoadPromise) { await violenceLoadPromise; return; }
  violenceLoadPromise = (async () => {
    violenceTextEmbeddings = await Promise.all(VIOLENCE_PROMPTS.map(embedText));
  })();
  await violenceLoadPromise;
}

/**
 * Cosine similarity tends to peak around 0.30–0.35 for genuine matches
 * with this embedder. We expose the raw max so the caller can tune
 * filter thresholds without re-running the indexer.
 */
export async function violenceScore(imagePath: string): Promise<number> {
  try {
    await ensureViolencePromptsEmbedded();
    if (!violenceTextEmbeddings) return 0;
    const imgEmb = await embedImage(imagePath);
    let best = 0;
    for (const t of violenceTextEmbeddings) {
      const s = cosine(imgEmb, t);
      if (s > best) best = s;
    }
    return Math.max(0, Math.min(1, best));
  } catch {
    return 0;
  }
}

/**
 * Score both signals for a single image. Convenience wrapper so the
 * indexer doesn't have to coordinate two awaits.
 */
export async function scoreSensitiveContent(
  imagePath: string,
): Promise<{ nsfw: number; violence: number }> {
  const [nsfw, violence] = await Promise.all([
    nsfwScore(imagePath),
    violenceScore(imagePath),
  ]);
  return { nsfw, violence };
}
