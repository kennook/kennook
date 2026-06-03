import { spawn } from 'node:child_process';

export interface VideoMetadata {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** Overall bit-rate in bits/sec. ffprobe reports it on the stream for some
   *  containers and only on the format for others, so we read either. */
  bitrate: number | null;
  /** Video codec name, e.g. 'h264', 'hevc', 'vp9'. */
  codec: string | null;
}

const EMPTY_META: VideoMetadata = {
  durationMs: null, width: null, height: null, bitrate: null, codec: null,
};

export async function probeVideo(videoPath: string): Promise<VideoMetadata> {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      // bit_rate + codec_name ride along the same probe — no extra subprocess.
      '-show_entries', 'stream=width,height,duration,bit_rate,codec_name:format=duration,bit_rate',
      '-of', 'json',
      videoPath,
    ]);

    const chunks: Buffer[] = [];
    ffprobe.stdout.on('data', (c) => chunks.push(c));
    ffprobe.on('error', () => resolve({ ...EMPTY_META }));
    ffprobe.on('close', () => {
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const stream = json.streams?.[0] ?? {};
        const durSec = parseFloat(stream.duration ?? json.format?.duration ?? '0');
        // Prefer the per-stream bit_rate; fall back to the container's. ffprobe
        // emits 'N/A' (or omits the field) when it can't determine one.
        const rawBitrate = stream.bit_rate ?? json.format?.bit_rate;
        const bitrate = rawBitrate != null ? parseInt(rawBitrate, 10) : NaN;
        resolve({
          durationMs: Number.isFinite(durSec) ? Math.round(durSec * 1000) : null,
          width: stream.width ?? null,
          height: stream.height ?? null,
          bitrate: Number.isFinite(bitrate) ? bitrate : null,
          codec: typeof stream.codec_name === 'string' ? stream.codec_name : null,
        });
      } catch {
        resolve({ ...EMPTY_META });
      }
    });
  });
}

export async function extractFrame(
  videoPath: string,
  timestampSeconds: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-ss', String(timestampSeconds),
      '-i', videoPath,
      '-frames:v', '1',
      '-f', 'image2',
      '-c:v', 'mjpeg',
      '-y',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (c) => chunks.push(c));
    ffmpeg.stderr.on('data', (c) => errChunks.push(c));
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0 && chunks.length) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg frame extraction failed (code ${code}): ${Buffer.concat(errChunks).toString('utf8').slice(0, 200)}`));
      }
    });
  });
}

/**
 * Decode a video's audio track to 16 kHz mono signed-16-bit PCM as a single
 * Buffer. Whisper expects this exact sample-rate + format. Returns an empty
 * Buffer when the video has no audio stream (silent video).
 */
export async function extractMonoPcm16k(videoPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-i', videoPath,
      '-vn',                  // no video
      '-ac', '1',             // mono
      '-ar', '16000',         // 16 kHz
      '-f', 's16le',          // raw little-endian s16 PCM
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      // ffmpeg exits non-zero when the input has no audio stream. Treat
      // that as an empty buffer rather than an error — silent videos
      // legitimately have no transcript.
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code === 0) return resolve(Buffer.concat(chunks));
      if (/Stream specifier .* matches no streams|does not contain any stream/i.test(stderr)) {
        return resolve(Buffer.alloc(0));
      }
      reject(new Error(`ffmpeg audio extraction failed (code ${code}): ${stderr.slice(0, 200)}`));
    });
  });
}

export async function ensureFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

export interface SceneChangeOptions {
  /** ffmpeg scene filter threshold (0–1). Higher = fewer, more confident
   *  scene changes. 0.3 is a sensible default for varied content. */
  threshold?: number;
  /** Drop scene changes that fire too close to a prior one (seconds).
   *  Default 2s — kills the jitter where a single transition triggers
   *  consecutive showinfo emissions. */
  coalesceWithinSec?: number;
  /** Always emit a frame every N seconds even if no scene change fires
   *  (covers static talking-head footage where on-screen text persists). */
  fixedIntervalSec?: number;
  /** Cap on total frames returned. Very long videos can otherwise emit
   *  hundreds of frames; the cap keeps OCR compute bounded. */
  maxFrames?: number;
}

/**
 * Detect scene-change timestamps via `ffmpeg -filter:v select='gt(scene,N)'`.
 * Parses showinfo output for pts_time values. Coalesces nearby fires and
 * optionally interleaves a fixed-interval floor so videos with very few
 * cuts still get periodic samples.
 *
 * Returns timestamps in milliseconds, sorted ascending.
 */
export async function detectSceneChanges(
  videoPath: string,
  options: SceneChangeOptions = {},
): Promise<number[]> {
  const threshold = options.threshold ?? 0.3;
  const coalesce = (options.coalesceWithinSec ?? 2) * 1000;
  const fixedInterval = options.fixedIntervalSec ?? null;
  const maxFrames = options.maxFrames ?? 500;

  const sceneTimes: number[] = await new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-i', videoPath,
      '-filter:v', `select='gt(scene,${threshold})',showinfo`,
      '-f', 'null',
      '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    ff.on('error', () => resolve([]));
    ff.on('close', () => {
      const out: number[] = [];
      // showinfo lines look like:
      //   [Parsed_showinfo_1 @ ...] n:0 pts:25000 pts_time:1.04167 ...
      const re = /pts_time:([0-9.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr)) !== null) {
        const sec = parseFloat(m[1]);
        if (Number.isFinite(sec)) out.push(Math.round(sec * 1000));
      }
      resolve(out);
    });
  });

  // Interleave a fixed-interval floor if requested. Useful when the scene
  // detector returns nothing (e.g. a static interview) but the video still
  // has on-screen text worth OCRing.
  if (fixedInterval !== null) {
    const duration = (await probeVideo(videoPath)).durationMs ?? 0;
    const stepMs = fixedInterval * 1000;
    for (let t = 0; t < duration; t += stepMs) sceneTimes.push(t);
  }

  // Sort + coalesce within `coalesce` ms of a prior accepted timestamp.
  sceneTimes.sort((a, b) => a - b);
  const out: number[] = [];
  let lastKept = -Infinity;
  for (const t of sceneTimes) {
    if (t - lastKept >= coalesce) {
      out.push(t);
      lastKept = t;
    }
  }
  // Cap: keep an evenly-spaced sample of `maxFrames` if we exceeded.
  if (out.length > maxFrames) {
    const stride = out.length / maxFrames;
    const capped: number[] = [];
    for (let i = 0; i < maxFrames; i++) capped.push(out[Math.floor(i * stride)]);
    return capped;
  }
  return out;
}
