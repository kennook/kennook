// Prints a banner before Next.js boots, listing every URL the dev server will
// be reachable on once it's up. Run as part of the `dev` npm script.

import os from 'node:os';

function getLocalIPv4s(): string[] {
  const ifaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

const PORT = process.env.PORT ?? '3000';
// macOS's os.hostname() already returns "name.local"; strip a trailing dot
// then a trailing ".local" so we don't end up appending it twice.
const hostname = os.hostname()
  .toLowerCase()
  .replace(/\.$/, '')
  .replace(/\.local$/, '');
const ips = getLocalIPv4s();

const lines: string[] = [];
lines.push('');
lines.push('  ╭─────────────────────────────────────────────────────────────────');
lines.push('  │  Kennook is reachable at:');
lines.push('  │');
lines.push(`  │    Local       http://localhost:${PORT}`);
if (hostname) {
  lines.push(`  │    mDNS        http://${hostname.toLowerCase()}.local:${PORT}`);
}
for (const ip of ips) {
  lines.push(`  │    Network     http://${ip}:${PORT}`);
}
if (!ips.length) {
  lines.push('  │    (no non-loopback network interfaces detected)');
}
lines.push('  │');
lines.push('  │  Open the network URL from any device on the same Wi-Fi.');
lines.push('  ╰─────────────────────────────────────────────────────────────────');
lines.push('');

console.log(lines.join('\n'));
