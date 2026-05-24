/**
 * Face detection + embedding via face-api.js (the @vladmandic fork) on a
 * tfjs-node backend. One module-level lazy load — first call pays the
 * model-load cost, every subsequent call reuses the loaded weights.
 *
 * Models are stored under `data/face-models/` and downloaded on demand
 * from the upstream face-api.js model repo on GitHub. They total ~6MB
 * (TinyFaceDetector ~190KB + FaceRecognitionNet ~6MB).
 *
 * Why these models specifically:
 *   - TinyFaceDetector: a small SSD-style detector that handles typical
 *     personal-library photos. Trades a bit of accuracy on tiny / heavily
 *     rotated faces for ~10× faster inference vs SSD MobilenetV1.
 *   - FaceRecognitionNet: ResNet-34 trained on FaceNet-style triplet
 *     loss, outputs 128-d unit-norm embeddings. Cosine-comparable.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
// Polyfill MUST be first — see file header. Patches util.isNullOrUndefined
// back onto node:util so tfjs-node 4.22 doesn't crash on Node 22+.
import './tfjs-node-polyfill';
// tfjs-node MUST be imported before face-api so the native backend is the
// one that gets registered. Importing in the wrong order silently falls
// back to the slow pure-JS CPU backend.
import * as tf from '@tensorflow/tfjs-node';
import * as faceapi from '@vladmandic/face-api';

const MODELS_DIR = path.join(process.cwd(), 'data', 'face-models');
// face-api's model repo lives under the upstream package; mirroring via
// jsDelivr is more reliable than GitHub raw (no rate limits, gzip on the
// way out). Path layout matches what `loadFromDisk` expects.
const MODEL_BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';

const MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  // FaceLandmark68Net is required by withFaceDescriptors() — the
  // recognition pipeline uses the 68-point landmarks to align the face
  // crop before computing the descriptor. .withFaceLandmarks(false) only
  // hides the landmarks from the result; it doesn't skip the model.
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
];

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function ensureModelsDownloaded(): Promise<void> {
  await fs.mkdir(MODELS_DIR, { recursive: true });
  for (const name of MODEL_FILES) {
    const local = path.join(MODELS_DIR, name);
    if (await fileExists(local)) continue;
    process.stdout.write(`  ↳ downloading ${name}… `);
    const res = await fetch(`${MODEL_BASE}/${name}`);
    if (!res.ok) {
      process.stdout.write(`FAILED (${res.status})\n`);
      throw new Error(`Failed to download face model ${name}: ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(local, buf);
    process.stdout.write(`${(buf.length / 1024).toFixed(0)} KB\n`);
  }
}

let loadPromise: Promise<void> | null = null;
async function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await ensureModelsDownloaded();
    // Wait for tfjs-node's native backend to register.
    await tf.ready();
    await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
  })();
  return loadPromise;
}

export interface DetectedFace {
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  /** Length-128 unit-norm vector. Persist as Buffer via Float32Array. */
  embedding: Float32Array;
}

// Detector knobs: 416 input matches the model's native canvas — bigger
// doesn't help much. Score threshold of 0.55 is conservative; tune lower
// (0.4) if missing legitimate faces, higher (0.7) if catching too many
// false positives.
const detectorOptions = new faceapi.TinyFaceDetectorOptions({
  inputSize: 416,
  scoreThreshold: 0.55,
});

// Resize big images before inference. The detector is sized for ~416px;
// feeding 4K straight in wastes a lot of GPU/CPU on irrelevant detail and
// can hit tfjs allocator ceilings. 1280 on the long edge is a comfortable
// upper bound that preserves enough detail to find small group-photo faces.
const MAX_INFERENCE_DIM = 1280;

/**
 * Detect every face in `imagePath` and return a 128-d embedding per face,
 * with bounding box in ORIGINAL-image pixel coordinates (not the
 * downscaled tensor we fed to the detector).
 */
export async function detectFaces(imagePath: string): Promise<DetectedFace[]> {
  await ensureLoaded();

  const img = sharp(imagePath, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return [];

  const scale = Math.min(1, MAX_INFERENCE_DIM / Math.max(meta.width, meta.height));
  const targetW = Math.round(meta.width * scale);
  const targetH = Math.round(meta.height * scale);

  // Decode + resize to a raw RGB buffer, then wrap as a tensor. tfjs-node
  // has no built-in image decoder for the formats we care about; sharp
  // handles JPEG/PNG/HEIC/etc. and gives us a tidy uint8 buffer.
  const { data, info } = await img
    .resize(targetW, targetH, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Tidy the intermediate tensors with tf.tidy. We can't tidy across the
  // awaited inference call, but we can dispose the input tensor manually.
  const input = tf.tensor3d(
    new Uint8Array(data),
    [info.height, info.width, 3],
    'int32',
  ) as unknown as faceapi.TNetInput;

  try {
    const detections = await faceapi
      .detectAllFaces(input, detectorOptions)
      .withFaceLandmarks()
      .withFaceDescriptors();

    const out: DetectedFace[] = [];
    for (const d of detections) {
      const box = d.detection.box;
      // Scale bbox back to original image coords.
      const inv = 1 / scale;
      out.push({
        bbox: {
          x: Math.max(0, Math.round(box.x * inv)),
          y: Math.max(0, Math.round(box.y * inv)),
          width: Math.round(box.width * inv),
          height: Math.round(box.height * inv),
        },
        confidence: d.detection.score,
        embedding: new Float32Array(d.descriptor),
      });
    }
    return out;
  } finally {
    (input as unknown as tf.Tensor).dispose();
  }
}

/** Convert a 128-d Float32Array to a Buffer for sqlite-vec storage. */
export function faceEmbeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
