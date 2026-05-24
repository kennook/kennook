import { NextRequest } from 'next/server';
import fs from 'node:fs';
import { getRawSqlite } from '@/db/client';
import { parseWorkspaceCookie } from '@/server/workspaces';

export async function GET(req: NextRequest, ctx: { params: Promise<{ uuid: string }> }) {
  const { uuid } = await ctx.params;
  // Cross-workspace items (e.g. playlists) pass ?ws=<slug>; everything else
  // falls back to the active workspace cookie.
  const wsParam = req.nextUrl.searchParams.get('ws');
  const workspace = wsParam ?? parseWorkspaceCookie(req.headers.get('cookie'));

  const sqlite = getRawSqlite(workspace);
  const row = sqlite.prepare(
    'SELECT thumbnail_path FROM media_items WHERE uuid = ?',
  ).get(uuid) as { thumbnail_path: string | null } | undefined;

  if (!row?.thumbnail_path || !fs.existsSync(row.thumbnail_path)) {
    return new Response('Not found', { status: 404 });
  }

  const data = await fs.promises.readFile(row.thumbnail_path);
  return new Response(data, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
