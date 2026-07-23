/**
 * HLS reverse proxy — makes CORS-locked live streams (IPTV / M3U) playable in the
 * browser. hls.js fetches the manifest + segments via XHR, which the browser
 * subjects to CORS; many public streams only allow their own origin, so they fail
 * (see the "This stream couldn't be played" case). Routing them through KenNook's
 * own origin (server-to-server fetch has no CORS) fixes that.
 *
 * SECURITY: this is NOT an open proxy. Every proxied URL is HMAC-signed with the
 * per-instance secret; the route refuses anything it didn't sign. The seed URL is
 * signed server-side (in the externalSource router, only for HLS stream items),
 * and each nested URL inside a fetched manifest is re-signed by the rewriter — so
 * the proxy can only ever fetch URLs that originated from a stream KenNook already
 * knows about. Combined with the http(s)-only + private-host guards below, that
 * keeps it from being an SSRF vector.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSessionSecret } from './auth';

const PROXY_PATH = '/api/hls-proxy';

function sign(url: string): string {
  return createHmac('sha256', getSessionSecret()).update(url).digest('hex');
}

/** Build a signed proxy URL for `url`. */
export function proxyUrl(url: string): string {
  return `${PROXY_PATH}?u=${encodeURIComponent(url)}&s=${sign(url)}`;
}

/** Constant-time check that `sig` is our signature for `url`. */
export function verifySig(url: string, sig: string): boolean {
  const expected = sign(url);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** HLS manifest URL heuristic (extension or content-type at fetch time). */
export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url);
}
export function isHlsContentType(ct: string | null): boolean {
  return !!ct && /mpegurl|vnd\.apple\.mpegurl/i.test(ct);
}

/** Reject non-http(s) and obvious internal/loopback hosts (basic SSRF guard). */
export function isSafeUpstream(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return false;
  // Literal private / loopback / link-local IPv4 + IPv6 loopback.
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (host === '::1' || host === '[::1]') return false;
  return true;
}

/**
 * Rewrite an HLS manifest so every nested URL (variant playlists, segments, keys,
 * alt renditions) points back through the signed proxy — resolved against the
 * manifest's FINAL fetched URL so relative paths and post-redirect bases are
 * correct.
 */
export function rewriteManifest(text: string, baseUrl: string): string {
  const abs = (ref: string): string => {
    try { return proxyUrl(new URL(ref, baseUrl).toString()); } catch { return ref; }
  };
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (t === '') return line;
    if (t.startsWith('#')) {
      // Rewrite URI="..." attributes on EXT-X-KEY / EXT-X-MEDIA / EXT-X-MAP etc.
      return line.replace(/URI="([^"]+)"/gi, (_m, uri: string) => `URI="${abs(uri)}"`);
    }
    // A bare line is a segment or a variant-playlist URL.
    return abs(t);
  }).join('\n');
}
