// Generates marketing/public/version.json from the ROOT package.json version,
// so kennook.com/version.json always reflects the latest released app version.
// Run at marketing build time (see package.json `prebuild` + `build:all`) — the
// generated file is bundled into public/ and served (CDN-cached) at /version.json.
//
// Self-hosted KenNook servers poll this (src/server/system/update.ts) to detect
// that a newer version is available. The version is the single source of truth:
// bump the root package.json, push to main, and the next prod deploy publishes it.
//
// Optional `notes`/`url` can be supplied per release via env without code changes
// (e.g. set them as `production` GitHub-environment variables on the deploy job).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)); // marketing/scripts
const rootPkgPath = path.resolve(here, '../../package.json'); // repo root
const publicDir = path.resolve(here, '../public'); // marketing/public
const outPath = path.join(publicDir, 'version.json');

const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
if (!pkg.version) {
  console.error('[gen-version] root package.json has no version field');
  process.exit(1);
}

const manifest = {
  version: pkg.version,
  // Both optional in the manifest contract; included only when provided so we
  // never emit a dead "release notes" link.
  ...(process.env.KENNOOK_RELEASE_NOTES ? { notes: process.env.KENNOOK_RELEASE_NOTES } : {}),
  ...(process.env.KENNOOK_RELEASE_URL ? { url: process.env.KENNOOK_RELEASE_URL } : {}),
  generatedAt: new Date().toISOString(),
};

mkdirSync(publicDir, { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[gen-version] wrote ${path.relative(process.cwd(), outPath)} → v${manifest.version}`);
