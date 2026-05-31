import { NextRequest } from 'next/server';
import fs from 'node:fs';
import { getRawSqlite } from '@/db/client';
import { parseLibraryCookie } from '@/server/libraries';

export async function GET(req: NextRequest, ctx: { params: Promise<{ uuid: string }> }) {
  const { uuid } = await ctx.params;
  // Cross-library items (e.g. playlists) pass ?lib=<slug> (legacy ?ws= still
  // honored); everything else falls back to the active library cookie.
  const wsParam = req.nextUrl.searchParams.get('lib') ?? req.nextUrl.searchParams.get('ws');
  const library = wsParam ?? parseLibraryCookie(req.headers.get('cookie'));

  const sqlite = getRawSqlite(library);
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
