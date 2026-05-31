/**
 * GET /api/text-frame/<uuid>?t=<ms>&lib=<slug>
 *
 * Serves the 256px JPEG that enrich-video-text saved for an OCR
 * occurrence. Drives the "match at 0:45" tile in search results.
 *
 * Falls back to the item's normal thumbnail if the frame isn't on disk
 * (e.g. occurrence saved before frame thumbs landed, or `t` doesn't
 * match a kept frame).
 */

import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { libraryRoot, parseLibraryCookie } from '@/server/libraries';

export async function GET(req: NextRequest, ctx: { params: Promise<{ uuid: string }> }) {
  const { uuid } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const t = sp.get('t');
  const libParam = sp.get('lib') ?? sp.get('ws');
  const library = libParam ?? parseLibraryCookie(req.headers.get('cookie'));

  if (!t || !/^\d+$/.test(t)) {
    return new Response('Bad request — `t` (ms) required', { status: 400 });
  }

  const framePath = path.join(libraryRoot(library), 'text-frames', uuid, `${t}.jpg`);
  if (!fs.existsSync(framePath)) {
    // 404 here is cheap — the search UI sees it and falls back to the
    // item's main thumbnail. Avoid leaking a static fallback from this
    // route so the client can decide.
    return new Response('Not found', { status: 404 });
  }

  const data = await fs.promises.readFile(framePath);
  return new Response(data, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
