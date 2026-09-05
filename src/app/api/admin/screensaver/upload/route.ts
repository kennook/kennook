/**
 * POST /api/admin/screensaver/upload — admin uploads a custom screensaver clip.
 *
 * Saves the raw upload under DATA_ROOT/screensavers/<id>/source<ext>, registers
 * the clip as `processing`, and queues an out-of-band ffmpeg normalization to
 * web-safe MP4 (see server/screensavers.ts). The response returns as soon as the
 * bytes are on disk — transcoding continues in the background and the admin UI
 * polls for the `ready`/`failed` flip.
 *
 * tRPC can't carry file bodies, so this is a plain route handler gated by
 * `requireAdmin`, mirroring /api/admin/upload.
 */

import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { requireAdmin } from '@/server/admin/require-admin';
import { kindForExt } from '@/indexer/media-extensions';
import { ensureFfmpegAvailable } from '@/indexer/ffmpeg';
import { createScreensaver, removeScreensaver, screensaverDir, enqueueTranscode } from '@/server/screensavers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Screensaver SOURCES should be short loops. A generous cap that still rejects
// someone trying to store a whole movie; the encoded output is duration-clamped
// separately (see MAX_DURATION_SEC in server/screensavers.ts).
const MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

export async function POST(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;

  let form: FormData;
  try { form = await req.formData(); }
  catch { return Response.json({ error: 'Expected multipart/form-data' }, { status: 400 }); }

  const file = form.get('file');
  const name = String(form.get('name') ?? '').trim();

  if (!(file instanceof File)) {
    return Response.json({ error: 'Missing file' }, { status: 400 });
  }
  const ext = path.extname(file.name).toLowerCase();
  if (kindForExt(ext) !== 'video') {
    return Response.json(
      { error: `Unsupported file type "${ext || file.name}". Upload a video (mp4, mov, m4v, webm).` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: `File too large (${(file.size / 1e9).toFixed(2)} GB). Max ${(MAX_BYTES / 1e9).toFixed(0)} GB.` },
      { status: 413 },
    );
  }

  // ffmpeg is the same system binary the indexer relies on. Fail fast with a
  // clear message if a misconfigured host doesn't have it, rather than accepting
  // the upload and marking it failed a moment later.
  if (!(await ensureFfmpegAvailable())) {
    return Response.json(
      { error: 'ffmpeg is not available on the server, so uploads can’t be processed. Install it (e.g. `brew install ffmpeg`).' },
      { status: 503 },
    );
  }

  const clip = createScreensaver(name || file.name.replace(/\.[^.]+$/, ''));
  const sourcePath = path.join(screensaverDir(clip.id), `source${ext}`);

  try {
    await pipeline(
      Readable.fromWeb(file.stream() as unknown as NodeWebReadableStream),
      fs.createWriteStream(sourcePath),
    );
  } catch (err) {
    removeScreensaver(clip.id); // roll back the registry entry + dir
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Failed to save file: ${msg}` }, { status: 500 });
  }

  enqueueTranscode(clip.id, sourcePath);
  return Response.json({ ok: true, id: clip.id, name: clip.name, status: clip.status });
}
