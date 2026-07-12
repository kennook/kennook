/**
 * Face detection + recognition, both ONNX via onnxruntime-node.
 *
 * Detection: YuNet (OpenCV Zoo, MIT) — a proper WIDER-FACE detector that emits
 * a box + 5 landmarks and rarely misfires on non-faces. It replaced face-api's
 * TinyFaceDetector, which hallucinated faces on sunflowers/documents/cartoons
 * and pooled them into junk clusters.
 * Recognition: ArcFace `arcfaceresnet100-8` (Apache-2.0) — align each face to
 * the canonical template via a 5-point similarity transform (using YuNet's
 * landmarks) and embed. Output: 512-d, L2-normalized. Different people separate
 * cleanly (~1.0 apart); same person stays tight.
 *
 * This module no longer depends on face-api.js or tfjs-node — the whole pipeline
 * is two ONNX sessions. Models live under `data/face-models/`, downloaded on
 * demand:
 *   - face_detection_yunet_2023mar.onnx (~230KB) from the OpenCV HF mirror
 *   - arcfaceresnet100-8.onnx (~249MB) from the onnxmodelzoo HF mirror
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';

const MODELS_DIR = path.join(process.cwd(), 'data', 'face-models');

const YUNET_FILE = 'face_detection_yunet_2023mar.onnx';
const YUNET_URL = `https://huggingface.co/opencv/face_detection_yunet/resolve/main/${YUNET_FILE}`;
const ARCFACE_FILE = 'arcfaceresnet100-8.onnx';
const ARCFACE_URL = `https://huggingface.co/onnxmodelzoo/arcfaceresnet100-8/resolve/main/${ARCFACE_FILE}`;

// YuNet runs at a fixed 640×640; detection input is letterboxed to it.
const YUNET_SIZE = 640;
const YUNET_STRIDES = [8, 16, 32];
const YUNET_CONF = 0.6;      // sqrt(cls·obj) score cutoff
const YUNET_NMS_IOU = 0.3;

const ARC_SIZE = 112;
const ARC_TEMPLATE: number[][] = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041],
];
// YuNet's landmark order is [right-eye, left-eye, nose, right-mouth, left-mouth]
// in image space, which matches ARC_TEMPLATE's spatial order 1:1.

const MAX_WARP_DIM = 1280; // cap the buffer we crop aligned faces from

export interface DetectedFace {
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  /** Length-512 unit-norm ArcFace vector. Persist as Buffer via Float32Array. */
  embedding: Float32Array;
  /** Yaw asymmetry in [0,1): ~0 = frontal, higher = toward profile. Enrich steps
   *  drop faces above FRONTAL_MAX_ASYMMETRY (ArcFace embeds profiles poorly). */
  yawAsym: number;
}

/** Faces above this yaw asymmetry are too non-frontal to embed reliably. */
export const FRONTAL_MAX_ASYMMETRY = 0.35;

// ── Model loading ───────────────────────────────────────────────────────────
async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}
async function downloadTo(url: string, dest: string, label: string): Promise<void> {
  process.stdout.write(`  ↳ downloading ${label}… `);
  const res = await fetch(url);
  if (!res.ok) { process.stdout.write(`FAILED (${res.status})\n`); throw new Error(`Failed to download ${label}: ${res.status}`); }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  process.stdout.write(`${(buf.length / 1024 / 1024).toFixed(1)} MB\n`);
}

let loadPromise: Promise<void> | null = null;
let yunet: ort.InferenceSession | null = null;
let arc: ort.InferenceSession | null = null;
let arcIn = 'data';
let arcOut = 'fc1';
async function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await fs.mkdir(MODELS_DIR, { recursive: true });
    const yPath = path.join(MODELS_DIR, YUNET_FILE);
    const aPath = path.join(MODELS_DIR, ARCFACE_FILE);
    if (!(await fileExists(yPath))) await downloadTo(YUNET_URL, yPath, `${YUNET_FILE} (YuNet detector)`);
    if (!(await fileExists(aPath))) await downloadTo(ARCFACE_URL, aPath, `${ARCFACE_FILE} (ArcFace, ~249MB, one-time)`);
    yunet = await ort.InferenceSession.create(yPath);
    arc = await ort.InferenceSession.create(aPath);
    arcIn = arc.inputNames[0] ?? arcIn;
    arcOut = arc.outputNames[0] ?? arcOut;
  })();
  return loadPromise;
}

// ── YuNet decode ────────────────────────────────────────────────────────────
interface RawDet { score: number; x: number; y: number; w: number; h: number; lm: number[] }

/** Decode YuNet's per-stride cls/obj/bbox/kps grids into boxes+landmarks (in
 *  640×640 letterbox coords), then NMS. Priors are grid centers, row-major. */
function decodeYunet(out: ort.InferenceSession.OnnxValueMapType): RawDet[] {
  const dets: RawDet[] = [];
  for (const s of YUNET_STRIDES) {
    const cls = out[`cls_${s}`].data as Float32Array;
    const obj = out[`obj_${s}`].data as Float32Array;
    const bbox = out[`bbox_${s}`].data as Float32Array;
    const kps = out[`kps_${s}`].data as Float32Array;
    const feat = YUNET_SIZE / s;
    for (let i = 0; i < feat * feat; i++) {
      const score = Math.sqrt(Math.max(0, cls[i]) * Math.max(0, obj[i]));
      if (score < YUNET_CONF) continue;
      const c = i % feat; const r = Math.floor(i / feat);
      const cx = (c + bbox[i * 4]) * s; const cy = (r + bbox[i * 4 + 1]) * s;
      const w = Math.exp(bbox[i * 4 + 2]) * s; const h = Math.exp(bbox[i * 4 + 3]) * s;
      const lm: number[] = [];
      for (let k = 0; k < 5; k++) { lm.push((c + kps[i * 10 + 2 * k]) * s, (r + kps[i * 10 + 2 * k + 1]) * s); }
      dets.push({ score, x: cx - w / 2, y: cy - h / 2, w, h, lm });
    }
  }
  return nms(dets, YUNET_NMS_IOU);
}

function nms(dets: RawDet[], iouThresh: number): RawDet[] {
  dets.sort((a, b) => b.score - a.score);
  const keep: RawDet[] = [];
  const suppressed = new Array(dets.length).fill(false);
  for (let i = 0; i < dets.length; i++) {
    if (suppressed[i]) continue;
    keep.push(dets[i]);
    for (let j = i + 1; j < dets.length; j++) {
      if (suppressed[j]) continue;
      const a = dets[i]; const b = dets[j];
      const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
      const x2 = Math.min(a.x + a.w, b.x + b.w); const y2 = Math.min(a.y + a.h, b.y + b.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const iou = inter / (a.w * a.h + b.w * b.h - inter);
      if (iou > iouThresh) suppressed[j] = true;
    }
  }
  return keep;
}

// ── Alignment math (5-point similarity transform + bilinear warp) ────────────
function similarityTransform(src: number[][], dst: number[][]): [number, number, number, number] {
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; const b = [0, 0, 0, 0];
  const add = (row: number[], y: number) => { for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; b[i] += row[i] * y; } };
  for (let i = 0; i < src.length; i++) { const [sx, sy] = src[i]; const [dx, dy] = dst[i]; add([sx, -sy, 1, 0], dx); add([sy, sx, 0, 1], dy); }
  return solve4(A, b);
}
function solve4(A: number[][], b: number[]): [number, number, number, number] {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-9;
    for (let r = 0; r < 4; r++) { if (r === col) continue; const f = M[r][col] / d; for (let c = col; c <= 4; c++) M[r][c] -= f * M[col][c]; }
  }
  return [M[0][4] / (M[0][0] || 1e-9), M[1][4] / (M[1][1] || 1e-9), M[2][4] / (M[2][2] || 1e-9), M[3][4] / (M[3][3] || 1e-9)];
}
/** Warp an RGB buffer to a 112×112 ArcFace input tensor (NCHW float32, RAW
 *  [0,255] — this model bakes in its own scaling). Backward-maps each output
 *  pixel through the inverse similarity transform, bilinear + edge clamp. */
function warpToArcInput(src: Buffer, sw: number, sh: number, m: [number, number, number, number]): Float32Array {
  const [a, b, tx, ty] = m; const det = a * a + b * b || 1e-9;
  const out = new Float32Array(3 * ARC_SIZE * ARC_SIZE); const plane = ARC_SIZE * ARC_SIZE;
  for (let oy = 0; oy < ARC_SIZE; oy++) {
    for (let ox = 0; ox < ARC_SIZE; ox++) {
      const px = ox - tx; const py = oy - ty;
      let sx = (a * px + b * py) / det; let sy = (-b * px + a * py) / det;
      sx = sx < 0 ? 0 : sx > sw - 1 ? sw - 1 : sx; sy = sy < 0 ? 0 : sy > sh - 1 ? sh - 1 : sy;
      const x0 = Math.floor(sx); const y0 = Math.floor(sy); const x1 = x0 + 1 < sw ? x0 + 1 : x0; const y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = sx - x0; const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 3; const i10 = (y0 * sw + x1) * 3; const i01 = (y1 * sw + x0) * 3; const i11 = (y1 * sw + x1) * 3;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bot = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out[c * plane + oy * ARC_SIZE + ox] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return out;
}
async function arcEmbed(input: Float32Array): Promise<Float32Array> {
  const t = new ort.Tensor('float32', input, [1, 3, ARC_SIZE, ARC_SIZE]);
  const o = await arc!.run({ [arcIn]: t });
  const raw = o[arcOut].data as Float32Array;
  const emb = new Float32Array(raw.length); let norm = 0;
  for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < raw.length; i++) emb[i] = raw[i] / norm;
  return emb;
}

// ── Detection + recognition ─────────────────────────────────────────────────
/** RGB buffer → YuNet NCHW input tensor (BGR, raw [0,255] — OpenCV convention). */
function yunetInput(rgb: Buffer): ort.Tensor {
  const plane = YUNET_SIZE * YUNET_SIZE; const data = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    data[p] = rgb[p * 3 + 2];          // B
    data[plane + p] = rgb[p * 3 + 1];  // G
    data[2 * plane + p] = rgb[p * 3];  // R
  }
  return new ort.Tensor('float32', data, [1, 3, YUNET_SIZE, YUNET_SIZE]);
}

async function detectFacesCore(makeSharp: () => sharp.Sharp): Promise<DetectedFace[]> {
  await ensureLoaded();
  const meta = await makeSharp().metadata();
  if (!meta.width || !meta.height) return [];
  const W = meta.width; const H = meta.height;

  // Warp buffer: ≤1280 RGB, cropped-from source for aligned faces. Use the
  // buffer's ACTUAL dimensions (fit:'inside' rounds), never computed ones.
  const { data: warpBuf, info: wi } = await makeSharp()
    .resize(MAX_WARP_DIM, MAX_WARP_DIM, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const aw = wi.width; const ah = wi.height;

  // YuNet input: aspect-preserving resize of the source into ≤640, then pad to
  // a centered 640×640. Again driven by the resized buffer's actual dims.
  const { data: rData, info: ri } = await makeSharp()
    .resize(YUNET_SIZE, YUNET_SIZE, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rw = ri.width; const rh = ri.height;
  const padX = Math.floor((YUNET_SIZE - rw) / 2); const padY = Math.floor((YUNET_SIZE - rh) / 2);
  const lb = await sharp(rData as Buffer, { raw: { width: rw, height: rh, channels: 3 } })
    .extend({ top: padY, left: padX, bottom: YUNET_SIZE - rh - padY, right: YUNET_SIZE - rw - padX, background: { r: 0, g: 0, b: 0 } })
    .raw().toBuffer();

  const out = await yunet!.run({ input: yunetInput(lb as Buffer) });
  const dets = decodeYunet(out as ort.InferenceSession.OnnxValueMapType);

  // Coordinate maps: letterbox → original uses (px−pad)·(dim/resized); original
  // → warp buffer multiplies by aw/W (== ah/H). Composed below.
  const toOrigX = (px: number) => (px - padX) * W / rw;
  const toOrigY = (py: number) => (py - padY) * H / rh;
  const toWarpX = (px: number) => (px - padX) * aw / rw;
  const toWarpY = (py: number) => (py - padY) * ah / rh;

  const results: DetectedFace[] = [];
  for (const d of dets) {
    const src5: number[][] = [];
    for (let k = 0; k < 5; k++) src5.push([toWarpX(d.lm[2 * k]), toWarpY(d.lm[2 * k + 1])]);
    const m = similarityTransform(src5, ARC_TEMPLATE);
    const embedding = await arcEmbed(warpToArcInput(warpBuf as Buffer, aw, ah, m));

    const [le, re, no] = [src5[0], src5[1], src5[2]];
    const dL = Math.hypot(no[0] - le[0], no[1] - le[1]);
    const dR = Math.hypot(no[0] - re[0], no[1] - re[1]);
    const yawAsym = Math.abs(dL - dR) / Math.max(dL, dR, 1e-6);

    const ox = toOrigX(d.x); const oy = toOrigY(d.y);
    results.push({
      bbox: { x: Math.max(0, Math.round(ox)), y: Math.max(0, Math.round(oy)), width: Math.round(d.w * W / rw), height: Math.round(d.h * H / rh) },
      confidence: d.score,
      embedding,
      yawAsym,
    });
  }
  return results;
}

/** Detect faces in an image file on disk. */
export async function detectFaces(imagePath: string): Promise<DetectedFace[]> {
  return detectFacesCore(() => sharp(imagePath, { failOn: 'none' }).rotate());
}

/** Convert a 512-d Float32Array to a Buffer for sqlite-vec storage. */
export function faceEmbeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
