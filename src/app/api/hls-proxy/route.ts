/**
 * GET /api/hls-proxy?u=<url>&s=<sig>
 *
 * Reverse-proxies an HLS manifest or media segment through KenNook's origin so
 * CORS-locked live streams play in the browser. Only serves URLs it signed (see
 * server/hls-proxy.ts). Manifests are rewritten so their nested URLs proxy too;
 * segments/keys are streamed through untouched.
 */

import { NextRequest } from 'next/server';
import {
  verifySig, isSafeUpstream, isHlsUrl, isHlsContentType, rewriteManifest,
} from '@/server/hls-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Pretend to be a generic player — some CDNs reject a missing/odd UA.
const UPSTREAM_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; KenNook/1.0)',
  accept: '*/*',
};

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const url = sp.get('u');
  const sig = sp.get('s');
  if (!url || !sig) return new Response('Missing params', { status: 400 });
  if (!verifySig(url, sig)) return new Response('Bad signature', { status: 403 });
  if (!isSafeUpstream(url)) return new Response('Blocked host', { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(url, { headers: UPSTREAM_HEADERS, redirect: 'follow' });
  } catch (e) {
    return new Response(`Upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`, { status: 502 });
  }
  if (!upstream.ok) {
    return new Response(`Upstream ${upstream.status}`, { status: 502 });
  }

  const ct = upstream.headers.get('content-type');
  const finalUrl = upstream.url || url; // resolved base after any redirects

  // Manifest → rewrite nested URLs to keep them proxied; else stream through.
  if (isHlsContentType(ct) || isHlsUrl(finalUrl) || isHlsUrl(url)) {
    const text = await upstream.text();
    const rewritten = rewriteManifest(text, finalUrl);
    return new Response(rewritten, {
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store', // live manifests are re-fetched constantly
      },
    });
  }

  // Segment / key / other media — stream the bytes through with the upstream type.
  return new Response(upstream.body, {
    headers: {
      'content-type': ct ?? 'application/octet-stream',
      'cache-control': 'public, max-age=30',
    },
  });
}
