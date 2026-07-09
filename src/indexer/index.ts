import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';
import { getRawSqlite } from '@/db/client';
import { embedImage, floatArrayToBuffer } from '@/ai/embeddings';
import {
  DEFAULT_LIBRARY_SLUG,
  resolveLibrary,
  libraryRoot,
  libraryThumbnailsDir,
  type Library,
} from '@/server/libraries';
import { ensureFfmpegAvailable, extractFrame, probeVideo } from './ffmpeg';
import { emitProgress } from './progress';
import { buildStorageRouter, relativeMediaPath, type StorageRouter } from '@/server/storage';
import { IMAGE_EXTS, VIDEO_EXTS, kindForExt } from './media-extensions';

const DEFAULT_USER_ID = 1;

interface PipelineCtx {
  filepath: string;
  filename: string;
  ext: string;
  kind: 'photo' | 'video';
  stat: fs.Stats;
}

interface CliArgs {
  librarySlug: string;
  targetPath: string | null;
  retry: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let librarySlug = DEFAULT_LIBRARY_SLUG;
  let targetPath: string | null = null;
  let retry = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library' || a === '-w') {
      const v = argv[++i];
      if (!v) throw new Error('--library requires a value');
      librarySlug = v;
    } else if (a.startsWith('--library=')) {
      librarySlug = a.split('=')[1];
    } else if (a === '--retry') {
      retry = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('-')) {
      targetPath = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!retry && !targetPath) {
    printHelp();
    process.exit(1);
  }
  return { librarySlug, targetPath, retry };
}

function printHelp() {
  console.log(`Usage:
  pnpm indexer [--library <slug>] <path>     Index a folder
  pnpm indexer --retry [--library <slug>]    Retry files that failed in a prior run

Failures are persisted to data/<slug>/failed-files.json after each run.
`);
}

// ─── Skip rules ───────────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  'System Volume Information', '$RECYCLE.BIN', 'RECYCLER', // Windows
  'lost+found',                                              // Linux
  'node_modules', '.git',                                    // dev junk
]);

function shouldSkipDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  // Dot-prefixed dirs: macOS's .Spotlight-V100, .fseventsd, .Trashes, etc.
  if (name.startsWith('.')) return true;
  return false;
}

async function* walkDirectory(dir: string): AsyncGenerator<PipelineCtx> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\n⚠ Skipping ${dir}: ${msg}\n`);
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      yield* walkDirectory(path.join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    const kind = IMAGE_EXTS.has(ext) ? 'photo' : VIDEO_EXTS.has(ext) ? 'video' : null;
    if (!kind) continue;

    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      continue;
    }
    yield { filepath: full, filename: entry.name, ext, kind, stat };
  }
}

// ─── Failure tracking ─────────────────────────────────────────────────────
interface FailedFile {
  path: string;
  error: string;
  attemptedAt: number;
}

function failedFilesPath(slug: string): string {
  return path.join(libraryRoot(slug), 'failed-files.json');
}

function readFailedFiles(slug: string): FailedFile[] {
  const p = failedFilesPath(slug);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFailedFiles(slug: string, list: FailedFile[]) {
  const p = failedFilesPath(slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(list, null, 2) + '\n', 'utf8');
}

function clearFailedFiles(slug: string) {
  const p = failedFilesPath(slug);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ─── Hashing + metadata ───────────────────────────────────────────────────
async function sha256OfFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(p);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const NO_PHOTO_META = { capturedAt: null, capturedLat: null, capturedLon: null, cameraMake: null, cameraModel: null };

async function readPhotoMetadata(p: string) {
  // Read a bounded header ourselves and hand exifr a Buffer, rather than a path.
  // Passing a path makes exifr open a FileHandle it doesn't reliably close on
  // malformed files — and on Node 22+ a FileHandle GC'd without an explicit
  // close throws ERR_INVALID_STATE, which aborts the whole indexer process.
  // EXIF/TIFF lives at the very start of a JPEG, so 256 KB is ample.
  let buf: Buffer | null = null;
  const handle = await fs.promises.open(p, 'r').catch(() => null);
  if (handle) {
    try {
      const { size } = await handle.stat();
      const len = Math.min(256 * 1024, size);
      if (len > 0) {
        const b = Buffer.alloc(len);
        await handle.read(b, 0, len, 0);
        buf = b;
      }
    } catch {
      // unreadable header — fall through to no-metadata
    } finally {
      await handle.close().catch(() => {});
    }
  }
  if (!buf) return NO_PHOTO_META;

  try {
    const exif = await exifr.parse(buf, {
      tiff: true, exif: true, gps: true, xmp: false, icc: false, jfif: false,
    });
    return {
      capturedAt: exif?.DateTimeOriginal instanceof Date
        ? exif.DateTimeOriginal.getTime()
        : exif?.CreateDate instanceof Date ? exif.CreateDate.getTime() : null,
      capturedLat: typeof exif?.latitude === 'number' ? exif.latitude : null,
      capturedLon: typeof exif?.longitude === 'number' ? exif.longitude : null,
      cameraMake: exif?.Make ?? null,
      cameraModel: exif?.Model ?? null,
    };
  } catch {
    return NO_PHOTO_META;
  }
}

async function ensureDir(p: string) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function generatePhotoVariants(
  srcPath: string,
  thumbPath: string,
  previewPath: string,
) {
  const meta = await sharp(srcPath).metadata();
  // Read+orient once, then resize twice from the same in-memory buffer.
  // ~2x faster than re-decoding the source file for each variant.
  const oriented = await sharp(srcPath).rotate().toBuffer();

  await sharp(oriented)
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(thumbPath);

  await sharp(oriented)
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(previewPath);

  return { width: meta.width ?? null, height: meta.height ?? null };
}

async function generateVideoThumbnail(srcPath: string, dstPath: string) {
  const probe = await probeVideo(srcPath);
  const ts = probe.durationMs ? Math.max(1, probe.durationMs / 1000 * 0.1) : 1;
  const frame = await extractFrame(srcPath, ts);
  await sharp(frame)
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(dstPath);
  return probe;
}

// ─── Core processing pipeline ─────────────────────────────────────────────
async function processOne(ctx: PipelineCtx, librarySlug: string, router: StorageRouter) {
  const sqlite = getRawSqlite(librarySlug);

  // Empty (0-byte) files — usually failed/partial downloads — have no moov atom
  // and can't be probed or thumbnailed. Skip them cleanly up front instead of
  // letting ffmpeg fail per-file with a scary multi-line dump.
  if (ctx.stat.size === 0) return { status: 'skip-empty' as const };

  // Route this file to the storage_location whose root_path is the longest
  // matching prefix. The seeded default storage at root_path="/" acts as a
  // catch-all so any abs path matches at least it.
  const storage = router.findFor(ctx.filepath);
  if (!storage) {
    throw new Error(
      `no storage location configured for path "${ctx.filepath}" — ` +
      `add one via the Storage admin or seed a catch-all at root_path="/"`,
    );
  }

  // media_items.path is stored relative to the storage's root_path.
  const relPath = relativeMediaPath(storage.root_path, ctx.filepath);

  // Fast path: any file the indexer has SEEN before — whether it was stored or
  // skipped as a content-duplicate — is recorded in indexed_files by
  // (storage, path, size). Match there and skip WITHOUT reading/hashing the
  // file. This is what makes re-scans of a large drive fast, including the many
  // "clip(1).mp4" duplicate downloads that never get their own media_items row.
  const seen = sqlite
    .prepare(`SELECT sha256 FROM indexed_files WHERE storage_location_id = ? AND path = ? AND size_bytes = ?`)
    .get(storage.id, relPath, ctx.stat.size) as { sha256: string } | undefined;
  if (seen) {
    const item = sqlite.prepare('SELECT id, uuid FROM media_items WHERE sha256 = ? LIMIT 1')
      .get(seen.sha256) as { id: number; uuid: string } | undefined;
    // item carries the uuid so the progress panel can show its thumbnail. If it
    // vanished (deleted), fall through and re-index.
    if (item) return { status: 'skip-duplicate' as const, id: item.id, uuid: item.uuid };
  }

  // New or changed file — hash for content dedup. Record it in indexed_files
  // (on success below) so future re-scans skip it on the cheap path above.
  const hash = await sha256OfFile(ctx.filepath);
  const recordSeen = () => sqlite
    .prepare(`INSERT OR REPLACE INTO indexed_files (storage_location_id, path, size_bytes, sha256) VALUES (?, ?, ?, ?)`)
    .run(storage.id, relPath, ctx.stat.size, hash);

  const existing = sqlite
    .prepare('SELECT id, uuid FROM media_items WHERE sha256 = ? LIMIT 1')
    .get(hash) as { id: number; uuid: string } | undefined;

  // Content-duplicate of a stored item (same bytes, different name): record the
  // path so it's skipped cheaply next time, and carry the stored uuid for the
  // progress thumbnail.
  if (existing) {
    recordSeen();
    return { status: 'skip-duplicate' as const, id: existing.id, uuid: existing.uuid };
  }

  const uuid = crypto.randomUUID();
  const thumbDir = libraryThumbnailsDir(librarySlug);
  const previewDir = path.join(libraryRoot(librarySlug), 'previews');
  await ensureDir(thumbDir);

  const thumbPath = path.join(thumbDir, `${uuid}.jpg`);
  const previewPath = path.join(previewDir, `${uuid}.jpg`);

  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  let videoBitrate: number | null = null;
  let videoCodec: string | null = null;
  let capturedAt: number | null = ctx.stat.mtimeMs;
  let capturedLat: number | null = null;
  let capturedLon: number | null = null;
  let cameraMake: string | null = null;
  let cameraModel: string | null = null;
  let storedPreviewPath: string | null = null;

  if (ctx.kind === 'photo') {
    await ensureDir(previewDir);
    const meta = await readPhotoMetadata(ctx.filepath);
    capturedAt = meta.capturedAt ?? capturedAt;
    capturedLat = meta.capturedLat;
    capturedLon = meta.capturedLon;
    cameraMake = meta.cameraMake;
    cameraModel = meta.cameraModel;
    const dims = await generatePhotoVariants(ctx.filepath, thumbPath, previewPath);
    width = dims.width;
    height = dims.height;
    storedPreviewPath = previewPath;
  } else {
    const probe = await generateVideoThumbnail(ctx.filepath, thumbPath);
    width = probe.width;
    height = probe.height;
    durationMs = probe.durationMs;
    videoBitrate = probe.bitrate;
    videoCodec = probe.codec;
  }

  const embedding = await embedImage(thumbPath);

  const insert = sqlite.prepare(`
    INSERT INTO media_items (
      uuid, user_id, storage_location_id, path, filename, kind,
      size_bytes, width, height, duration_ms, video_bitrate, video_codec, sha256,
      captured_at, captured_lat, captured_lon, camera_make, camera_model,
      thumbnail_path, preview_path, embedding_status
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, 'indexed'
    )
  `);

  const result = insert.run(
    uuid,
    DEFAULT_USER_ID,
    storage.id,
    relPath,
    ctx.filename,
    ctx.kind,
    ctx.stat.size,
    width,
    height,
    durationMs,
    videoBitrate,
    videoCodec,
    hash,
    capturedAt,
    capturedLat,
    capturedLon,
    cameraMake,
    cameraModel,
    thumbPath,
    storedPreviewPath,
  );

  const mediaId = Number(result.lastInsertRowid);

  sqlite
    .prepare('INSERT INTO media_embeddings (rowid, embedding) VALUES (?, ?)')
    .run(BigInt(mediaId), floatArrayToBuffer(embedding));

  recordSeen(); // remember this path so re-scans skip it without hashing
  return { status: 'indexed' as const, id: mediaId, uuid };
}

// ─── Run modes ────────────────────────────────────────────────────────────
async function runFreshIndex(absTarget: string, library: Library, ffmpegOk: boolean) {
  console.log(`Indexing ${absTarget} → library "${library.name}" (${library.slug})`);

  const sqlite = getRawSqlite(library.slug);
  const router = buildStorageRouter(sqlite);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  const failures: FailedFile[] = [];
  const start = Date.now();

  // Emit structured progress every Nth processed file so the admin
  // UI can render the live progress card. Walk is streaming (no
  // pre-count), so `total` is omitted — the UI shows the running
  // count + the file currently being processed.
  const PROGRESS_EVERY = 10;
  let processedSoFar = 0;
  // The uuid of the most-recently-indexed item. Emitted as the progress
  // currentItem (kind='uuid') so the admin panel resolves its freshly-made
  // thumbnail — and so the "recent" strip stays thumbnailed rather than
  // showing path placeholders during runs of skips/failures.
  let lastUuid: string | null = null;

  for await (const ctx of walkDirectory(absTarget)) {
    if (ctx.kind === 'video' && !ffmpegOk) {
      skipped++;
      continue;
    }
    // The uuid of the item processed THIS iteration — set for both freshly
    // indexed items and duplicate-skips (both have a thumbnail on disk), so the
    // panel shows a thumbnail even on all-duplicate re-index runs.
    let itemUuid: string | null = null;
    // Only freshly-indexed items trigger a per-file progress emit — they're slow
    // (thumbnail + embedding), so smooth thumbnails are worth it. Skips are fast
    // and only emit on the periodic tick, so a fast re-scan isn't throttled by a
    // progress line (→ runner DB write + SSE) per skipped file.
    let freshlyIndexed = false;
    try {
      const result = await processOne(ctx, library.slug, router);
      if (result.status === 'indexed') {
        indexed++;
        itemUuid = result.uuid;
        lastUuid = result.uuid;
        freshlyIndexed = true;
        process.stdout.write(`\r✓ ${indexed} indexed, ${skipped} skipped, ${failed} failed   `);
      } else {
        skipped++;
        if (result.status === 'skip-duplicate') {
          itemUuid = result.uuid;
          lastUuid = result.uuid;
        } else if (result.status === 'skip-empty') {
          // Note empty files on their own line so it's clear WHY they were
          // skipped (not silently, not as a "failed" ffmpeg error).
          process.stdout.write(`\n⊘ ${ctx.filename}: empty file (0 bytes), skipped\n`);
        }
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ path: ctx.filepath, error: msg, attemptedAt: Date.now() });
      process.stdout.write(`\n✗ ${ctx.filename}: ${msg}\n`);
    }
    processedSoFar++;
    // Per-file emit for freshly-indexed items (smooth thumbnails); otherwise a
    // periodic tick — which still carries the latest item's uuid so the panel
    // shows a thumbnail and the counts stay live through skip/fail stretches.
    if (freshlyIndexed || processedSoFar % PROGRESS_EVERY === 0) {
      const showUuid = itemUuid ?? lastUuid;
      emitProgress({
        step: 'Indexing',
        current: processedSoFar,
        label: `scanning files (${indexed} indexed, ${skipped} skipped, ${failed} failed)`,
        currentItem: showUuid ?? ctx.filepath,
        currentItemKind: showUuid ? 'uuid' : 'path',
        currentItemLibrary: showUuid ? library.slug : undefined,
      });
    }
  }
  // Final progress beat so the UI's last-render reflects the full count.
  emitProgress({
    step: 'Indexing',
    current: processedSoFar,
    total: processedSoFar,
    label: `done — ${indexed} indexed, ${skipped} skipped, ${failed} failed`,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone. Indexed ${indexed}, skipped ${skipped}, failed ${failed} in ${elapsed}s.`);

  // Persist (or clear) the failure list.
  if (failures.length > 0) {
    writeFailedFiles(library.slug, failures);
    console.log(`\n${failures.length} failure(s) saved to ${failedFilesPath(library.slug)}`);
    console.log(`Retry with:  pnpm indexer --retry --library ${library.slug}`);
  } else {
    clearFailedFiles(library.slug);
  }
}

async function runRetry(library: Library, ffmpegOk: boolean) {
  const failures = readFailedFiles(library.slug);
  if (failures.length === 0) {
    console.log(`No failed files to retry for library "${library.name}" (${library.slug}).`);
    return;
  }

  console.log(`Retrying ${failures.length} failed file(s) in library "${library.name}"`);

  const sqlite = getRawSqlite(library.slug);
  const router = buildStorageRouter(sqlite);

  const stillFailed: FailedFile[] = [];
  let succeeded = 0;
  let vanished = 0;
  const start = Date.now();

  for (const fail of failures) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fail.path);
    } catch {
      vanished++;
      process.stdout.write(`\n↷ Skipping (no longer present): ${fail.path}\n`);
      continue;
    }

    const ext = path.extname(fail.path).toLowerCase();
    const kind: 'photo' | 'video' | null =
      IMAGE_EXTS.has(ext) ? 'photo' : VIDEO_EXTS.has(ext) ? 'video' : null;
    if (!kind) {
      vanished++;
      continue;
    }
    if (kind === 'video' && !ffmpegOk) {
      stillFailed.push({
        path: fail.path,
        error: 'ffmpeg not available',
        attemptedAt: Date.now(),
      });
      continue;
    }

    const ctx: PipelineCtx = {
      filepath: fail.path,
      filename: path.basename(fail.path),
      ext,
      kind,
      stat,
    };

    try {
      const result = await processOne(ctx, library.slug, router);
      // skip-empty resolves a prior failure (the file is 0 bytes — nothing to
      // index), so it leaves the failing set rather than lingering forever.
      if (result.status === 'indexed' || result.status === 'skip-duplicate' || result.status === 'skip-empty') {
        succeeded++;
        process.stdout.write(`\r✓ ${succeeded} succeeded, ${stillFailed.length} still failing   `);
      } else {
        stillFailed.push({
          path: fail.path,
          error: 'unexpected non-success status',
          attemptedAt: Date.now(),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stillFailed.push({ path: fail.path, error: msg, attemptedAt: Date.now() });
      process.stdout.write(`\n✗ ${ctx.filename}: ${msg}\n`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nRetry done in ${elapsed}s. Succeeded ${succeeded}, vanished ${vanished}, still failing ${stillFailed.length}.`);

  if (stillFailed.length === 0) {
    clearFailedFiles(library.slug);
    console.log('All failures resolved — failure list cleared.');
  } else {
    writeFailedFiles(library.slug, stillFailed);
    console.log(`${stillFailed.length} still failing. Re-run \`pnpm indexer --retry --library ${library.slug}\` to try again.`);
  }
}

// Index a single file (e.g. an admin upload). Mirrors the per-file logic in
// runRetry, but for one explicit path. processOne handles storage routing,
// dedup, thumbnails, metadata, embedding, and the insert.
async function runSingleFile(absTarget: string, library: Library, ffmpegOk: boolean) {
  const ext = path.extname(absTarget).toLowerCase();
  const kind = kindForExt(ext);
  if (!kind) {
    console.error(`Unsupported file type "${ext || absTarget}" — not an image or video KenNook can index.`);
    process.exit(1);
  }
  if (kind === 'video' && !ffmpegOk) {
    console.error('ffmpeg not available — cannot index a video. Install with: brew install ffmpeg');
    process.exit(1);
  }

  const sqlite = getRawSqlite(library.slug);
  const router = buildStorageRouter(sqlite);
  const stat = await fs.promises.stat(absTarget);
  const ctx: PipelineCtx = {
    filepath: absTarget,
    filename: path.basename(absTarget),
    ext,
    kind,
    stat,
  };

  console.log(`Indexing 1 file → library "${library.name}" (${library.slug})`);
  emitProgress({
    step: 'Indexing', current: 0, total: 1,
    label: `indexing ${ctx.filename}`,
    currentItem: absTarget, currentItemKind: 'path',
  });

  try {
    const result = await processOne(ctx, library.slug, router);
    const done = result.status === 'indexed' ? 'indexed' : 'skipped (duplicate)';
    emitProgress({
      step: 'Indexing', current: 1, total: 1, label: `done — ${done}`,
      ...(result.status === 'indexed' || result.status === 'skip-duplicate'
        ? { currentItem: result.uuid, currentItemKind: 'uuid' as const, currentItemLibrary: library.slug }
        : {}),
    });
    console.log(result.status === 'indexed'
      ? `✓ Indexed ${ctx.filename}`
      : `↷ Skipped ${ctx.filename} (duplicate of item #${result.id})`);
  } catch (err) {
    // Single-file mode intentionally does NOT touch failed-files.json — that
    // list is library-wide and overwriting it here would clobber a prior scan's
    // failures. The non-zero exit + stderr is what the job runner records.
    const msg = err instanceof Error ? err.message : String(err);
    emitProgress({ step: 'Indexing', current: 1, total: 1, label: `failed — ${msg}` });
    console.error(`✗ ${ctx.filename}: ${msg}`);
    process.exit(1);
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────
async function main() {
  const { librarySlug, targetPath, retry } = parseArgs(process.argv.slice(2));
  const library = resolveLibrary(librarySlug);

  const ffmpegOk = await ensureFfmpegAvailable();
  if (!ffmpegOk) {
    console.warn('⚠ ffmpeg not found on PATH. Videos will be skipped. Install with: brew install ffmpeg');
  }

  if (retry) {
    await runRetry(library, ffmpegOk);
    return;
  }

  const absTarget = path.resolve(targetPath!);
  if (!fs.existsSync(absTarget)) {
    console.error(`Path does not exist: ${absTarget}`);
    process.exit(1);
  }

  // A directory walks as a fresh index; a single file (e.g. an admin upload)
  // indexes just that one file.
  if (fs.statSync(absTarget).isDirectory()) {
    await runFreshIndex(absTarget, library, ffmpegOk);
  } else {
    await runSingleFile(absTarget, library, ffmpegOk);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
