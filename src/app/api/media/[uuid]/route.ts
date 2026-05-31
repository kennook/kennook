import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { getRawSqlite } from '@/db/client';
import { parseLibraryCookie } from '@/server/libraries';
import { parseRootPath, resolveMediaPath } from '@/server/storage';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ uuid: string }> }) {
  const { uuid } = await ctx.params;
  const wsParam = req.nextUrl.searchParams.get('lib') ?? req.nextUrl.searchParams.get('ws');
  const library = wsParam ?? parseLibraryCookie(req.headers.get('cookie'));
  const sqlite = getRawSqlite(library);

  const row = sqlite.prepare(
    `SELECT m.path AS rel_path, m.mime_type, sl.config AS storage_config
     FROM media_items m
     JOIN storage_locations sl ON sl.id = m.storage_location_id
     WHERE m.uuid = ?`,
  ).get(uuid) as { rel_path: string; mime_type: string | null; storage_config: string } | undefined;

  if (!row) return new Response('Not found', { status: 404 });

  const absPath = resolveMediaPath(parseRootPath(row.storage_config), row.rel_path);
  if (!fs.existsSync(absPath)) return new Response('Not found', { status: 404 });

  const ext = path.extname(absPath).toLowerCase();
  const contentType = row.mime_type ?? MIME[ext] ?? 'application/octet-stream';
  const stat = await fs.promises.stat(absPath);
  const total = stat.size;

  const range = req.headers.get('range');
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(absPath, { start, end });
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          'content-length': String(chunkSize),
          'content-type': contentType,
        },
      });
    }
  }

  const stream = fs.createReadStream(absPath);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      'content-type': contentType,
      'content-length': String(total),
      'accept-ranges': 'bytes',
    },
  });
}
