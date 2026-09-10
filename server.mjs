/**
 * KenNook native TLS terminator (opt-in) — "Slice 2b".
 *
 * Serves the built Next app directly over HTTP/2 + TLS using the wildcard cert
 * the cloud agent obtained (data/cloud/certs/), so no separate reverse proxy
 * (caddy) is needed. HTTP/2 multiplexing is the point: one browser connection
 * instead of the 6-per-origin HTTP/1.1 cap, which ends the multi-window
 * connection clog.
 *
 * OPT-IN + NON-BREAKING: this is an ALTERNATE entry point (`pnpm start:tls`).
 * The default `next start` / `pnpm start:prod` path is untouched. And even here,
 * with no cert on disk we fall back to plain HTTP on KENNOOK_PORT — i.e. exactly
 * today's behavior — so nothing breaks before a cert exists.
 *
 * Env:
 *   KENNOOK_TLS_PORT            TLS listen port (default 443). Binding 443 needs
 *                               privilege — same as caddy does today. On Linux:
 *                               `setcap 'cap_net_bind_service=+ep' $(command -v node)`
 *                               or run under a service manager that grants it.
 *   KENNOOK_PORT                plain-HTTP fallback port when no cert (default 3001).
 *   KENNOOK_HOST                bind host (default '::' — dual-stack, like start:prod).
 *   KENNOOK_HTTP_REDIRECT_PORT  if set, also bind this port and 308-redirect to HTTPS.
 *   KENNOOK_DATA_ROOT           data dir (default ./data); cert lives under cloud/certs.
 *
 * Why the http2 adapter below: Next's Node request handler assumes an HTTP/1
 * ServerResponse and copies req.headers into a Web Headers for Route Handlers.
 * Over HTTP/2 that breaks two ways — a missing `_implicitHeader` and the ':'
 * pseudo-headers. The adapter bridges both. Validated (harness) across RSC
 * render, SSE (incremental), byte-range, static, and POST bodies. `allowHTTP1`
 * keeps a transparent HTTP/1.1 fallback for any client that can't do h2.
 */
import { createSecureServer } from 'node:http2';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import next from 'next';

const DATA_ROOT = process.env.KENNOOK_DATA_ROOT ?? './data';
const CERTS_DIR = path.join(DATA_ROOT, 'cloud', 'certs');
const KEY_PATH = path.join(CERTS_DIR, 'key.pem');
const CHAIN_PATH = path.join(CERTS_DIR, 'fullchain.pem');
const TLS_PORT = Number(process.env.KENNOOK_TLS_PORT ?? 443);
const HTTP_PORT = Number(process.env.KENNOOK_PORT ?? 3001);
const HOST = process.env.KENNOOK_HOST ?? '::';

function haveCert() {
  try { return fs.existsSync(KEY_PATH) && fs.existsSync(CHAIN_PATH); } catch { return false; }
}
function loadCert() {
  return { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CHAIN_PATH) };
}

/** Bridge an HTTP/2 request/response so Next's HTTP/1-oriented handler accepts
 *  it. Only touches h2 requests; the h1 path is byte-for-byte unchanged. */
function adaptHttp2(req, res) {
  // Snapshot method/url first — on the h2 compat request these getters read
  // :method / :path out of req.headers, so we must read them before swapping it.
  const method = req.method;
  const url = req.url;
  // Hand Next a headers object free of ':'-prefixed HTTP/2 pseudo-headers, which
  // a Web Headers object (used by Route Handlers) rejects.
  const clean = Object.create(null);
  for (const k in req.headers) if (k.charCodeAt(0) !== 58 /* ':' */) clean[k] = req.headers[k];
  Object.defineProperty(req, 'headers', { value: clean, configurable: true, writable: true });
  Object.defineProperty(req, 'method', { value: method, configurable: true, writable: true });
  Object.defineProperty(req, 'url', { value: url, configurable: true, writable: true });
  // Polyfill the HTTP/1-only ServerResponse internal Next calls when flushing
  // headers implicitly.
  if (typeof res._implicitHeader !== 'function') {
    res._implicitHeader = () => { if (!res.headersSent) res.writeHead(res.statusCode || 200); };
  }
}

const app = next({ dev: false });
const handle = app.getRequestHandler();
await app.prepare();

function onRequest(req, res) {
  if (req.httpVersionMajor >= 2) adaptHttp2(req, res);
  handle(req, res).catch((e) => {
    console.error('[request] handler error:', e);
    try { if (!res.headersSent) res.statusCode = 500; res.end('Internal Server Error'); } catch { /* already gone */ }
  });
}

/** Reload the SecureContext live when the cert on disk changes (renewal, or a
 *  manual swap) — no restart, no dropped connections. Debounced because a cert
 *  write touches several files in quick succession. */
function watchCert(server) {
  let timer = null;
  try {
    fs.watch(CERTS_DIR, (_evt, file) => {
      if (file && !/^(fullchain\.pem|key\.pem)$/.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { server.setSecureContext(loadCert()); console.log('[tls] certificate reloaded'); }
        catch (e) { console.error('[tls] cert reload failed:', e.message); }
      }, 1000);
    });
  } catch (e) {
    console.error('[tls] could not watch cert dir (renewal needs a restart):', e.message);
  }
}

function maybeRedirect() {
  const rp = process.env.KENNOOK_HTTP_REDIRECT_PORT;
  if (!rp) return;
  const suffix = TLS_PORT === 443 ? '' : `:${TLS_PORT}`;
  http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    res.writeHead(308, { location: `https://${host}${suffix}${req.url}` });
    res.end();
  }).on('error', (e) => console.error('[redirect] error:', e.message))
    .listen(Number(rp), HOST, () => console.log(`KenNook HTTP→HTTPS redirect on ${HOST}:${rp}`));
}

if (haveCert()) {
  const server = createSecureServer(
    { ...loadCert(), allowHTTP1: true, ALPNProtocols: ['h2', 'http/1.1'] },
    onRequest,
  );
  server.on('sessionError', (e) => console.error('[tls sessionError]', e.message));
  server.on('error', (e) => console.error('[tls server error]', e.message));
  server.listen(TLS_PORT, HOST, () => console.log(`KenNook serving TLS/HTTP-2 on ${HOST}:${TLS_PORT}`));
  watchCert(server);
  maybeRedirect();
} else {
  // No cert yet → behave like today's plain-HTTP instance (caddy still fronts it,
  // or the operator connects the cloud, gets a cert, and restarts with TLS).
  const server = http.createServer(onRequest);
  server.on('error', (e) => console.error('[http server error]', e.message));
  server.listen(HTTP_PORT, HOST, () =>
    console.log(`KenNook serving HTTP on ${HOST}:${HTTP_PORT} (no cert yet — TLS will activate once one is issued)`));
}
