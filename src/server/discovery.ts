/**
 * Zero-config LAN discoverability. Started once when the server boots (via
 * `src/instrumentation.ts`). Two parts, both requiring NOTHING from the user:
 *
 *   1. mDNS/Bonjour: advertise `kennook.local` so any device on the same Wi-Fi
 *      can open `http://kennook.local:<port>` with no DNS / hosts / router
 *      setup. (macOS, iOS, Windows 10+, Linux/Avahi resolve it natively.)
 *   2. A "Connect a device" payload — the LAN IP URL(s) — surfaced both in the
 *      boot banner (with a scannable QR) and via /api/connect-info for the UI.
 *      This is the universal fallback for networks where mDNS is flaky.
 *
 * No SSL, no caddy, no per-client config — the app does the discovery itself.
 * Pure-JS deps (bonjour-service / qrcode-terminal) so `pnpm install` stays
 * native-build-free.
 */

import os from 'node:os';

export const MDNS_HOST = 'kennook.local';

let started = false;
let activePort = 0;
// Kept loosely typed to avoid leaking the bonjour types across the app.
let bonjour: { unpublishAll: (cb?: () => void) => void; destroy: () => void } | null = null;

/** Resolve the port the Next server is listening on: PORT env, then a
 *  `-p/--port` flag (how `start:prod` sets 3001), else Next's default 3000. */
function detectPort(): number {
  const fromEnv = Number(process.env.PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-p' || argv[i] === '--port') && argv[i + 1]) {
      const p = Number(argv[i + 1]);
      if (Number.isInteger(p) && p > 0) return p;
    }
  }
  return 3000;
}

/** Non-loopback IPv4 addresses of this machine. */
export function getLanIps(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

export interface ConnectInfo {
  /** Pretty mDNS URL (resolves with zero config where mDNS works). */
  mdnsUrl: string;
  /** LAN IP URLs — the universal fallback. First is the primary. */
  networkUrls: string[];
  port: number;
}

export function getConnectInfo(): ConnectInfo {
  const port = activePort || detectPort();
  return {
    mdnsUrl: `http://${MDNS_HOST}:${port}`,
    networkUrls: getLanIps().map((ip) => `http://${ip}:${port}`),
    port,
  };
}

async function startMdns(port: number): Promise<void> {
  try {
    // Dynamic import so it stays out of the client bundle / edge runtime and
    // doesn't rely on `require` being present in the compiled server output.
    const { Bonjour } = await import('bonjour-service');
    const instance = new Bonjour();
    instance.publish({ name: 'KenNook', type: 'http', port, host: MDNS_HOST });
    bonjour = instance;
    const teardown = () => { try { bonjour?.unpublishAll(() => bonjour?.destroy()); } catch { /* noop */ } };
    process.once('SIGINT', teardown);
    process.once('SIGTERM', teardown);
  } catch {
    // mDNS unavailable (no multicast, locked-down host) — the IP URLs still work.
  }
}

async function printBanner(info: ConnectInfo): Promise<void> {
  const L: string[] = [];
  L.push('');
  L.push('  ╭─────────────────────────────────────────────────────────────');
  L.push('  │  KenNook is running. Open it at:');
  L.push('  │');
  L.push(`  │    This device     http://localhost:${info.port}`);
  // The IP is the universally reachable URL — list it first / prominently.
  for (const url of info.networkUrls) {
    L.push(`  │    Other devices   ${url}`);
  }
  if (!info.networkUrls.length) {
    L.push('  │    Other devices   (no Wi-Fi/Ethernet interface detected)');
  }
  // The mDNS name is a nicety that only resolves where mDNS is supported
  // (Apple devices, most desktops) and multicast isn't blocked — so it's
  // explicitly secondary, not "any device".
  L.push(`  │    Friendly name   ${info.mdnsUrl}  (only where mDNS works)`);
  L.push('  │');
  L.push('  │  On another device on the same Wi-Fi, use the IP URL above —');
  L.push('  │  or scan this (it encodes the IP, so it works anywhere):');
  L.push('  ╰─────────────────────────────────────────────────────────────');
  console.log(L.join('\n'));

  const primary = info.networkUrls[0] ?? info.mdnsUrl;
  try {
    // qrcode-terminal renders to stdout via a callback.
    const qrcode = (await import('qrcode-terminal')).default;
    qrcode.generate(primary, { small: true }, (qr: string) => console.log(qr));
  } catch {
    /* QR is a nicety — the URLs above are enough. */
  }
}

/** Idempotent. Called from instrumentation `register()` on server boot. */
export async function startDiscovery(): Promise<void> {
  if (started) return;
  started = true;
  activePort = detectPort();
  await startMdns(activePort);
  await printBanner(getConnectInfo());
}
