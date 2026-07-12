/**
 * GET /api/scrub-sprite/<uuid>?lib=<slug>
 *
 * Serves the pre-rendered scrub-preview sprite sheet (one montage JPEG of
 * evenly-spaced frames) that `enrich:scrub` saved to disk. The grid manifest
 * that maps a hover time → tile comes from `media.scrubSprite` (DB), not here.
 *
 * 404 when the sprite hasn't been generated yet; the client just shows no
 * preview and falls back to the plain scrubber.
 */

import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { libraryRoot, parseLibraryCookie } from '@/server/libraries';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ uuid: string }> }) {
  const { uuid } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const library = sp.get('lib') ?? sp.get('ws') ?? parseLibraryCookie(req.headers.get('cookie'));

  // uuid is a path segment — guard against traversal before touching the fs.
  if (!/^[a-zA-Z0-9-]+$/.test(uuid)) {
    return new Response('Bad request', { status: 400 });
  }

  const spritePath = path.join(libraryRoot(library), 'scrub-sprites', uuid, 'sprite.jpg');
  if (!fs.existsSync(spritePath)) {
    return new Response('Not found', { status: 404 });
  }

  const data = await fs.promises.readFile(spritePath);
  return new Response(data, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
