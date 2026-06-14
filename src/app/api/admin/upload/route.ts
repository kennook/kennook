/**
 * POST /api/admin/upload — admin uploads a photo/video into a library.
 *
 * Saves the file under the chosen storage location's root (in an `Uploads/`
 * subfolder), then enqueues the existing `indexer` job to index that single
 * file. Indexing runs in the indexer child process (thumbnail, metadata,
 * embedding, DB insert) and surfaces in the admin Jobs panel.
 *
 * Body: multipart/form-data with
 *   file      — the media file
 *   library   — target library slug
 *   storageId — storage_location id to store under (a real, non-`/` root)
 *
 * tRPC can't carry file bodies, so this is a plain route handler. Gated by
 * `requireAdmin` like the other /api/admin routes.
 */

import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { requireAdmin } from '@/server/admin/require-admin';
import { getRawSqlite } from '@/db/client';
import { getLibraryBySlug } from '@/server/libraries';
import { getStorageRootPath } from '@/server/storage';
import { enqueue, ensureRunnerStarted } from '@/server/admin/job-runner';
import { kindForExt } from '@/indexer/media-extensions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export async function POST(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;

  let form: FormData;
  try { form = await req.formData(); }
  catch { return Response.json({ error: 'Expected multipart/form-data' }, { status: 400 }); }

  const file = form.get('file');
  const slug = String(form.get('library') ?? '');
  const storageId = Number(form.get('storageId'));

  if (!(file instanceof File)) {
    return Response.json({ error: 'Missing file' }, { status: 400 });
  }
  if (!slug || !getLibraryBySlug(slug)) {
    return Response.json({ error: `Unknown library "${slug}"` }, { status: 400 });
  }
  if (!Number.isInteger(storageId)) {
    return Response.json({ error: 'Missing or invalid storageId' }, { status: 400 });
  }

  const ext = path.extname(file.name).toLowerCase();
  if (!kindForExt(ext)) {
    return Response.json(
      { error: `Unsupported file type "${ext || file.name}". Upload an image or video.` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: `File too large (${(file.size / 1e9).toFixed(2)} GB). Max ${(MAX_BYTES / 1e9).toFixed(0)} GB.` },
      { status: 413 },
    );
  }

  // Resolve the destination under the chosen storage's root.
  const sqlite = getRawSqlite(slug);
  let root: string;
  try { root = getStorageRootPath(sqlite, storageId); }
  catch { return Response.json({ error: `Storage ${storageId} not found in "${slug}"` }, { status: 400 }); }

  if (root === '/') {
    return Response.json(
      { error: 'Cannot upload into the catch-all "/" storage — pick a real storage location.' },
      { status: 400 },
    );
  }
  if (!fs.existsSync(root)) {
    return Response.json({ error: `Storage root "${root}" is not currently available.` }, { status: 409 });
  }

  const uploadsDir = path.join(root, 'Uploads');
  await fs.promises.mkdir(uploadsDir, { recursive: true });
  const dest = uniquePath(uploadsDir, sanitizeName(file.name));

  // Stream the body to disk so large videos don't buffer in memory.
  try {
    await pipeline(
      Readable.fromWeb(file.stream() as unknown as NodeWebReadableStream),
      fs.createWriteStream(dest),
    );
  } catch (err) {
    await fs.promises.rm(dest, { force: true });
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Failed to save file: ${msg}` }, { status: 500 });
  }

  // Index just this file. The indexer accepts a single-file path and routes it
  // to the storage whose root is its longest-matching prefix (this one).
  ensureRunnerStarted();
  try {
    const job = enqueue({
      command: 'indexer',
      args: { library: slug, path: dest },
      librarySlug: slug,
      userId: guard.user.id,
    });
    return Response.json({ ok: true, savedPath: dest, filename: path.basename(dest), job });
  } catch (err) {
    await fs.promises.rm(dest, { force: true });
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Saved the file but failed to queue indexing: ${msg}` }, { status: 500 });
  }
}

/** Strip path separators + leading dots so an upload can't escape the dir. */
function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[/\\]/g, '_').replace(/^\.+/, '');
  return base || 'upload';
}

/** A non-colliding path in `dir` for `name`, appending " (n)" before the ext. */
function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  }
  return candidate;
}
