/**
 * Custom (admin-uploaded) screensaver clips.
 *
 * An admin uploads any video the host's ffmpeg can read; we normalize it to
 * web-safe H.264 MP4 in the same two resolution slots the client already
 * expects (`720`, `1080`), silent and `+faststart` for instant playback. Once a
 * clip is `ready` it joins the screensaver rotation in place of the built-in
 * stock footage; with none uploaded, the built-in set is used.
 *
 * Storage follows the existing JSON-registry convention (cf. `libraries.json`,
 * `external-sources.json`): a `registry.json` index plus one dir per clip under
 * `DATA_ROOT/screensavers/`. Nothing goes in `public/` — that's committed and
 * not writable at runtime — so clips are served back through a range-capable
 * route (`/api/screensaver/media/[id]/[height]`).
 *
 * ffmpeg is the SAME system binary the indexer already requires (thumbnails,
 * sprites, probing); this adds no new bundled dependency. Transcodes run one at
 * a time, out of band from the upload request.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { probeVideo } from '@/indexer/ffmpeg';
import { publishToAll } from '@/server/sync-broker';

const DATA_ROOT = process.env.KENNOOK_DATA_ROOT ?? './data';
const SCREENSAVERS_DIR = path.join(DATA_ROOT, 'screensavers');
const REGISTRY_PATH = path.join(SCREENSAVERS_DIR, 'registry.json');

/** The resolution slots the client asks for. A clip stores one file per slot,
 *  each clamped to at most the slot height (never upscaled). */
export const SCREENSAVER_HEIGHTS = [720, 1080] as const;
export type ScreensaverHeight = (typeof SCREENSAVER_HEIGHTS)[number];

/** A screensaver clip is a short loop — cap the encoded length so nobody turns
 *  a feature-length upload into a multi-GB "screensaver". */
const MAX_DURATION_SEC = 120;

export type ScreensaverStatus = 'processing' | 'ready' | 'failed';
export interface CustomScreensaver {
  id: string;
  name: string;
  status: ScreensaverStatus;
  createdAt: number;
  /** Whether this clip is in the rotation. Only enabled + ready clips play;
   *  enable several to rotate, one to pin it. Absent = enabled (back-compat). */
  enabled?: boolean;
  /** Populated on failure with a short reason (surfaced in the admin UI). */
  error?: string;
}
interface Registry {
  version: 1;
  clips: CustomScreensaver[];
}

// ── Registry I/O ─────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(SCREENSAVERS_DIR)) fs.mkdirSync(SCREENSAVERS_DIR, { recursive: true });
}

function readRegistry(): Registry {
  ensureDir();
  if (!fs.existsSync(REGISTRY_PATH)) return { version: 1, clips: [] };
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
  } catch {
    // Corrupt index — treat as empty rather than wedging the screensaver.
    return { version: 1, clips: [] };
  }
}

function writeRegistry(reg: Registry): void {
  ensureDir();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Clip ids are UUIDs, so this is belt-and-suspenders against traversal — but
 *  every route that takes an id from the client still re-validates it. */
export function isValidScreensaverId(id: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

export function screensaverDir(id: string): string {
  return path.join(SCREENSAVERS_DIR, id);
}

export function screensaverVariantPath(id: string, height: number): string {
  return path.join(screensaverDir(id), `${height}.mp4`);
}

// ── Public queries ───────────────────────────────────────────────────────────

export function listScreensavers(): CustomScreensaver[] {
  return readRegistry().clips.sort((a, b) => b.createdAt - a.createdAt);
}

/** Ids of clips that are ready AND enabled — the rotation the client plays.
 *  (A clip with no `enabled` field counts as enabled, for back-compat.) */
export function readyScreensaverIds(): string[] {
  return readRegistry().clips
    .filter((c) => c.status === 'ready' && c.enabled !== false)
    .map((c) => c.id);
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function createScreensaver(name: string): CustomScreensaver {
  const reg = readRegistry();
  const clip: CustomScreensaver = {
    id: randomUUID(),
    name: name.trim() || 'Untitled',
    status: 'processing',
    createdAt: Date.now(),
    enabled: true,
  };
  reg.clips.push(clip);
  writeRegistry(reg);
  fs.mkdirSync(screensaverDir(clip.id), { recursive: true });
  return clip;
}

/** Tell every open client the rotation changed so it re-resolves its
 *  screensaver clip. `sessionId` is a synthetic non-tab id so no window skips
 *  it as its own echo — including the admin's own window. Cross-device via SSE
 *  (same limitation as `config.changed`: reaches clients on this process). */
function notifyManifestChanged(): void {
  publishToAll({ sessionId: 'server:screensaver', event: { type: 'screensaver.manifest.changed' } });
}

function updateScreensaver(id: string, patch: Partial<CustomScreensaver>): void {
  const reg = readRegistry();
  const clip = reg.clips.find((c) => c.id === id);
  if (!clip) return; // deleted mid-transcode — drop the update
  Object.assign(clip, patch);
  writeRegistry(reg);
}

/** Toggle a clip in/out of the rotation. No-op if the id is unknown. */
export function setScreensaverEnabled(id: string, enabled: boolean): void {
  updateScreensaver(id, { enabled });
  notifyManifestChanged();
}

/** Make one clip the sole enabled one — enable it, disable every other — in a
 *  single registry write. Notifies only if something actually changed. */
export function setOnlyScreensaver(id: string): void {
  const reg = readRegistry();
  let changed = false;
  for (const c of reg.clips) {
    const target = c.id === id;
    if ((c.enabled !== false) !== target) changed = true;
    c.enabled = target;
  }
  if (changed) {
    writeRegistry(reg);
    notifyManifestChanged();
  }
}

export function removeScreensaver(id: string): boolean {
  const reg = readRegistry();
  const before = reg.clips.length;
  reg.clips = reg.clips.filter((c) => c.id !== id);
  if (reg.clips.length === before) return false;
  writeRegistry(reg);
  fs.rmSync(screensaverDir(id), { recursive: true, force: true });
  notifyManifestChanged();
  return true;
}

// ── Transcode ────────────────────────────────────────────────────────────────

// Transcodes run strictly one-at-a-time in-process: an admin dropping several
// files at once shouldn't spawn a swarm of ffmpeg processes competing for the
// host. Each clip's variants also encode sequentially inside `transcodeClip`.
let transcodeChain: Promise<void> = Promise.resolve();

/** Queue a clip's source for normalization; returns immediately. The registry
 *  entry flips to `ready`/`failed` when it finishes. */
export function enqueueTranscode(id: string, sourcePath: string): void {
  transcodeChain = transcodeChain.then(() => transcodeClip(id, sourcePath)).catch(() => {});
}

async function transcodeClip(id: string, sourcePath: string): Promise<void> {
  try {
    // Probe once so we never UPSCALE: each slot is clamped to the source height.
    const meta = await probeVideo(sourcePath);
    const srcHeight = meta.height && meta.height > 0 ? meta.height : 1080;

    for (const slot of SCREENSAVER_HEIGHTS) {
      let h = Math.min(srcHeight, slot);
      h -= h % 2; // yuv420p needs even dimensions
      if (h < 2) h = 2;
      await encodeVariant(sourcePath, screensaverVariantPath(id, slot), h);
    }
    updateScreensaver(id, { status: 'ready', error: undefined });
    notifyManifestChanged(); // a new clip is now playable — refresh open windows
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateScreensaver(id, { status: 'failed', error: msg.slice(0, 300) });
    // Drop any half-written variants so a failed clip can't be served.
    for (const slot of SCREENSAVER_HEIGHTS) {
      fs.rmSync(screensaverVariantPath(id, slot), { force: true });
    }
  } finally {
    // Keep only the web variants — the original source can be large.
    await fs.promises.rm(sourcePath, { force: true }).catch(() => {});
  }
}

function encodeVariant(src: string, dest: string, height: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', src,
      '-t', String(MAX_DURATION_SEC),
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '23',
      '-movflags', '+faststart',
      '-an', // screensavers play muted — no need to carry (or transcode) audio
      dest,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const errChunks: Buffer[] = [];
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', reject); // e.g. ffmpeg not on PATH
    ff.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      // ffmpeg's real error is at the tail of stderr; the head is just its banner.
      const detail = Buffer.concat(errChunks).toString('utf8')
        .split('\n').map((l) => l.trim())
        .filter((l) => l && !/^(ffmpeg version|built with|configuration:|lib(av|sw))/.test(l))
        .slice(-2).join(' — ');
      reject(new Error(`transcode failed (code ${code}): ${detail || 'no output'}`));
    });
  });
}
