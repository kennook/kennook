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
  /** Whether this clip is the active screensaver. At most one clip is active at
   *  a time (selecting one deselects the others) — multiple windows on one
   *  machine each streaming a different clip exhausted the browser's per-origin
   *  connection pool, so rotation/multi-select was removed. Absent = enabled
   *  (back-compat; legacy multi-enabled installs are narrowed to one on read). */
  enabled?: boolean;
  /** Boomerang loop desired: play forward then reversed so it returns to the
   *  first frame seamlessly (fixes clips that aren't clean loops). */
  loop?: boolean;
  /** Generation status of the reversed-tail variant. Serving uses the looped
   *  file only when loop is desired AND this is 'ready'. */
  loopStatus?: ScreensaverStatus;
  /** Playback speed multiplier (one of SCREENSAVER_SPEEDS). Applied client-side
   *  as the video's playbackRate — no re-encoding. Absent = 1× (back-compat). */
  speed?: number;
  /** Populated on failure with a short reason (surfaced in the admin UI). */
  error?: string;
}

/** Allowed playback speeds. 1× is the default. */
export const SCREENSAVER_SPEEDS = [0.25, 0.5, 0.75, 1, 2, 3] as const;
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

/** The boomerang (forward + reversed) variant for a height. Served when the
 *  clip's loop is on and ready; otherwise the plain variant plays. */
export function screensaverLoopVariantPath(id: string, height: number): string {
  return path.join(screensaverDir(id), `${height}-loop.mp4`);
}

// ── Public queries ───────────────────────────────────────────────────────────

export function listScreensavers(): CustomScreensaver[] {
  return readRegistry().clips.sort((a, b) => b.createdAt - a.createdAt);
}

export interface ReadyScreensaver {
  id: string;
  /** True → the client should request the boomerang variant (`?loop=1`). */
  loop: boolean;
  /** Playback speed to apply client-side (defaults to 1). */
  speed: number;
}

/** The single active screensaver clip, as a 0-or-1 element array (the client
 *  expects a list). At most one clip plays at a time; if a legacy install has
 *  several still flagged enabled, the newest wins — deterministic, so every
 *  window on every device shows the same one (and shares its cached stream
 *  instead of each opening its own connection). Empty → the built-in set plays. */
export function readyScreensaverClips(): ReadyScreensaver[] {
  const active = readRegistry().clips
    .filter((c) => c.status === 'ready' && c.enabled !== false)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!active) return [];
  return [{ id: active.id, loop: active.loop === true && active.loopStatus === 'ready', speed: active.speed ?? 1 }];
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

/** Make a clip the active screensaver, or turn it off. Enabling one deselects
 *  every other (only one plays at a time); disabling just clears this one,
 *  falling back to the built-in set when nothing is left active. No-op if the
 *  id is unknown. */
export function setScreensaverEnabled(id: string, enabled: boolean): void {
  if (enabled) { setOnlyScreensaver(id); return; }
  updateScreensaver(id, { enabled: false });
  notifyManifestChanged();
}

/**
 * Turn the seamless (boomerang) loop on/off for a clip. Enabling generates a
 * reversed-tail variant in the background the first time; once generated it's
 * kept, so re-enabling later is instant. Disabling just flips the flag (the
 * looped files stay for a quick re-enable).
 */
export function setScreensaverLoop(id: string, loop: boolean): void {
  const reg = readRegistry();
  const clip = reg.clips.find((c) => c.id === id);
  if (!clip) return;

  if (!loop) {
    clip.loop = false;
    writeRegistry(reg);
    notifyManifestChanged();
    return;
  }

  clip.loop = true;
  if (clip.loopStatus === 'ready') {
    // Boomerang files already exist — enable instantly.
    writeRegistry(reg);
    notifyManifestChanged();
    return;
  }
  clip.loopStatus = 'processing';
  writeRegistry(reg);
  notifyManifestChanged(); // show "preparing loop…" in the admin list
  enqueueLoopGeneration(id);
}

/** Set a clip's playback speed (applied client-side; no re-encoding). Ignores
 *  a speed that isn't one of the allowed values. */
export function setScreensaverSpeed(id: string, speed: number): void {
  if (!(SCREENSAVER_SPEEDS as readonly number[]).includes(speed)) return;
  updateScreensaver(id, { speed });
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

// ── Seamless-loop (boomerang) generation ─────────────────────────────────────

/** Queue a clip's reversed-tail variants; runs on the same serial chain as
 *  transcodes so ffmpeg jobs don't pile up. */
export function enqueueLoopGeneration(id: string): void {
  transcodeChain = transcodeChain.then(() => generateLoopClip(id)).catch(() => {});
}

async function generateLoopClip(id: string): Promise<void> {
  try {
    for (const slot of SCREENSAVER_HEIGHTS) {
      const plain = screensaverVariantPath(id, slot);
      if (!fs.existsSync(plain)) continue; // variant missing — skip this slot
      await encodeBoomerang(plain, screensaverLoopVariantPath(id, slot));
    }
    updateScreensaver(id, { loopStatus: 'ready' });
  } catch {
    updateScreensaver(id, { loopStatus: 'failed' });
    for (const slot of SCREENSAVER_HEIGHTS) {
      fs.rmSync(screensaverLoopVariantPath(id, slot), { force: true });
    }
  }
  notifyManifestChanged();
}

// ffmpeg's real error is at the tail of stderr; the head is just its banner.
function ffmpegErrorTail(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !/^(ffmpeg version|built with|configuration:|lib(av|sw))/.test(l))
    .slice(-2).join(' — ');
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
      reject(new Error(`transcode failed (code ${code}): ${ffmpegErrorTail(errChunks) || 'no output'}`));
    });
  });
}

/**
 * Append a reversed copy so playback runs forward then backward, landing back on
 * the first frame — a seamless boomerang loop. The `reverse` filter buffers the
 * whole clip in memory, so this suits the short clips a screensaver uses (length
 * is already capped at transcode); the output is roughly double the duration.
 */
function encodeBoomerang(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', src,
      '-filter_complex', '[0:v]reverse[r];[0:v][r]concat=n=2:v=1[out]',
      '-map', '[out]',
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '23',
      '-movflags', '+faststart',
      '-an',
      dest,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const errChunks: Buffer[] = [];
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(`loop build failed (code ${code}): ${ffmpegErrorTail(errChunks) || 'no output'}`));
    });
  });
}
