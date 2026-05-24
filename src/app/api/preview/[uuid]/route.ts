import { NextRequest } from 'next/server';
import fs from 'node:fs';
import { getRawSqlite } from '@/db/client';
import { parseWorkspaceCookie } from '@/server/workspaces';

export async function GET(req: NextRequest, ctx: { params: Promise<{ uuid: string }> }) {
  const { uuid } = await ctx.params;
  const wsParam = req.nextUrl.searchParams.get('ws');
  const workspace = wsParam ?? parseWorkspaceCookie(req.headers.get('cookie'));
  const sqlite = getRawSqlite(workspace);

  const row = sqlite.prepare(
    'SELECT preview_path, thumbnail_path, path FROM media_items WHERE uuid = ?',
  ).get(uuid) as { preview_path: string | null; thumbnail_path: string | null; path: string } | undefined;

  if (!row) return new Response('Not found', { status: 404 });

  const target = (row.preview_path && fs.existsSync(row.preview_path))
    ? row.preview_path
    : (row.thumbnail_path && fs.existsSync(row.thumbnail_path))
      ? row.thumbnail_path
      : (fs.existsSync(row.path) ? row.path : null);

  if (!target) return new Response('Not found', { status: 404 });

  const data = await fs.promises.readFile(target);
  return new Response(data, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
