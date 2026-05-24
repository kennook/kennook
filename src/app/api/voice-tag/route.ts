/**
 * Voice tagging endpoint. Receives a raw audio blob (whatever
 * MediaRecorder produced — usually webm/opus on Chrome, mp4/aac on
 * Safari), transcodes to 16 kHz mono signed-16 PCM via ffmpeg, decodes
 * to a Float32Array, transcribes, and returns extracted noun tags.
 *
 * The client is responsible for actually committing the tags via the
 * existing `media.addUserTag` tRPC mutation — that keeps cache updates,
 * cross-tab sync events, and workspace/user resolution in one place.
 *
 * Audio flow:
 *   request body (webm/mp4) → tmp file
 *     → ffmpeg ... -f s16le -ar 16000 -ac 1 pipe:1
 *     → Buffer of raw PCM bytes
 *     → pcmS16ToFloat32 → Float32Array
 *     → voiceToTags → { transcript, tags }
 *
 * Why not pass a file path to transformers.js: the pipeline's path/URL
 * loader uses AudioContext, which is a browser API. In Node it throws
 * "AudioContext is not available in your environment", so we decode
 * the PCM ourselves and hand it a Float32Array directly.
 */

import { NextRequest } from 'next/server';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { voiceToTags, pcmS16ToFloat32 } from '@/ai/voice';

export const runtime = 'nodejs';
// Audio uploads can be a couple hundred kB; the default body parser is
// fine. We do NOT use the edge runtime because @huggingface/transformers
// and child_process aren't supported there.

/**
 * Run ffmpeg on `inputPath`, emit raw 16 kHz mono signed-16 little-
 * endian PCM on stdout, and return the collected bytes. Errors out if
 * ffmpeg exits non-zero or produces no audio.
 */
function ffmpegToPcm(inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-y',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (c) => stdoutChunks.push(c));
    proc.stderr.on('data', (c) => stderrChunks.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(
          `ffmpeg audio transcode failed (code ${code}): ` +
          Buffer.concat(stderrChunks).toString('utf8').slice(0, 300),
        ));
      }
      const pcm = Buffer.concat(stdoutChunks);
      if (pcm.byteLength < 2) {
        return reject(new Error('ffmpeg produced no audio (empty PCM output)'));
      }
      resolve(pcm);
    });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const contentType = req.headers.get('content-type') ?? 'audio/webm';
  const buffer = Buffer.from(await req.arrayBuffer());
  if (buffer.byteLength === 0) {
    return Response.json({ error: 'Empty audio body' }, { status: 400 });
  }
  // ffmpeg sniffs the container from contents, but giving it a sensible
  // extension makes debugging temp files easier.
  const ext = contentType.includes('mp4') ? 'mp4'
    : contentType.includes('ogg') ? 'ogg'
    : contentType.includes('wav') ? 'wav'
    : 'webm';

  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `kennook-voice-${id}.${ext}`);

  try {
    await fs.writeFile(inPath, buffer);
    const pcm = await ffmpegToPcm(inPath);
    const samples = pcmS16ToFloat32(pcm);
    const result = await voiceToTags(samples);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
  }
}
