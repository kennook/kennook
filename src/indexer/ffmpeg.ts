import { spawn } from 'node:child_process';

export interface VideoMetadata {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export async function probeVideo(videoPath: string): Promise<VideoMetadata> {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration:format=duration',
      '-of', 'json',
      videoPath,
    ]);

    const chunks: Buffer[] = [];
    ffprobe.stdout.on('data', (c) => chunks.push(c));
    ffprobe.on('error', () => resolve({ durationMs: null, width: null, height: null }));
    ffprobe.on('close', () => {
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const stream = json.streams?.[0] ?? {};
        const durSec = parseFloat(stream.duration ?? json.format?.duration ?? '0');
        resolve({
          durationMs: Number.isFinite(durSec) ? Math.round(durSec * 1000) : null,
          width: stream.width ?? null,
          height: stream.height ?? null,
        });
      } catch {
        resolve({ durationMs: null, width: null, height: null });
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

export async function ensureFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
