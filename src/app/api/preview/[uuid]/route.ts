import { NextRequest } from 'next/server';
import fs from 'node:fs';
import { getRawSqlite } from '@/db/client';
import { parseLibraryCookie } from '@/server/libraries';
import { parseRootPath, resolveMediaPath } from '@/server/storage';

export async function GET(req: NextRequest, ctx: { params: Promise<{ uuid: string }> }) {
  const { uuid } = await ctx.params;
  const wsParam = req.nextUrl.searchParams.get('lib') ?? req.nextUrl.searchParams.get('ws');
  const library = wsParam ?? parseLibraryCookie(req.headers.get('cookie'));
  const sqlite = getRawSqlite(library);

  const row = sqlite.prepare(
    `SELECT m.preview_path, m.thumbnail_path, m.path AS rel_path, sl.config AS storage_config
     FROM media_items m
     JOIN storage_locations sl ON sl.id = m.storage_location_id
     WHERE m.uuid = ?`,
  ).get(uuid) as {
    preview_path: string | null;
    thumbnail_path: string | null;
    rel_path: string;
    storage_config: string;
  } | undefined;

  if (!row) return new Response('Not found', { status: 404 });

  const absSource = resolveMediaPath(parseRootPath(row.storage_config), row.rel_path);
  const target = (row.preview_path && fs.existsSync(row.preview_path))
    ? row.preview_path
    : (row.thumbnail_path && fs.existsSync(row.thumbnail_path))
      ? row.thumbnail_path
      : (fs.existsSync(absSource) ? absSource : null);

  if (!target) return new Response('Not found', { status: 404 });

  const data = await fs.promises.readFile(target);
  return new Response(data, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
