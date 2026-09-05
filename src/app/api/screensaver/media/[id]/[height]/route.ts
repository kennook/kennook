/**
 * GET /api/screensaver/media/[id]/[height] — stream a custom screensaver
 * variant (720 or 1080) from DATA_ROOT, with HTTP Range support so the video
 * seeks/streams like the built-in clips (which Next serves from public/ with
 * ranges for free). Public: the screensaver plays to any viewer.
 */

import { NextRequest } from 'next/server';
import fs from 'node:fs';
import { isValidScreensaverId, screensaverVariantPath, SCREENSAVER_HEIGHTS } from '@/server/screensavers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; height: string }> },
): Promise<Response> {
  const { id, height } = await ctx.params;

  if (!isValidScreensaverId(id)) return new Response('Bad request', { status: 400 });
  const h = Number(height);
  if (!SCREENSAVER_HEIGHTS.includes(h as (typeof SCREENSAVER_HEIGHTS)[number])) {
    return new Response('Bad request', { status: 400 });
  }

  const absPath = screensaverVariantPath(id, h);
  if (!fs.existsSync(absPath)) return new Response('Not found', { status: 404 });

  const stat = await fs.promises.stat(absPath);
  const total = stat.size;
  const contentType = 'video/mp4';

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
