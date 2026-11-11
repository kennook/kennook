#!/usr/bin/env node
/**
 * Generate the PWA app icons from public/favicon.svg (a square 256×256 mark on a
 * dark rounded ground). Run after changing the logo:  node scripts/gen-pwa-icons.mjs
 *
 *   icon-192.png            — standard 192²   (purpose: any)
 *   icon-512.png            — standard 512²   (purpose: any)
 *   icon-512-maskable.png   — 512² with the mark padded into the maskable safe
 *                             zone on a full-bleed #1A1815 ground (purpose: maskable)
 *
 * Installed-PWA status is what grants Chrome autoplay-with-sound that survives a
 * reload (our auto-update), so these exist to make KenNook installable.
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url));
const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));
const BG = '#1A1815'; // matches the favicon's own ground

async function render(size) {
  // High render density so the SVG rasterizes crisply, then fit to size.
  return sharp(svg, { density: 512 }).resize(size, size, { fit: 'contain', background: BG });
}

async function main() {
  await (await render(192)).png().toFile(out('icon-192.png'));
  await (await render(512)).png().toFile(out('icon-512.png'));

  // Maskable: shrink the mark to ~80% and center it on a full-bleed ground so a
  // circular/rounded mask can't clip the logo.
  const inner = await (await render(410)).png().toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
    .composite([{ input: inner, gravity: 'center' }])
    .png()
    .toFile(out('icon-512-maskable.png'));

  console.log('✓ PWA icons written to public/: icon-192.png, icon-512.png, icon-512-maskable.png');
}

main().catch((e) => { console.error(e); process.exit(1); });
