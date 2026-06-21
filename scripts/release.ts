#!/usr/bin/env tsx
/**
 * Cut a release. One command:
 *
 *   pnpm release <patch|minor|major>
 *
 * Steps, in order:
 *   1. Refuse to run on a dirty tree / off the default branch (safety).
 *   2. Bump package.json `version` (the single source of truth → KENNOOK_VERSION).
 *   3. Roll CHANGELOG `[Unreleased]` into a dated `[x.y.z]` section (and open a
 *      fresh empty `[Unreleased]`).
 *   4. Commit + annotated tag `vx.y.z`, push commit and tag.
 *   5. Create a GitHub Release with the changelog section as the body
 *      (skipped with instructions if the `gh` CLI isn't installed).
 *
 * After this, the cloud deploy regenerates kennook.com/version.json from the
 * new version + notes, which self-hosted instances poll to show the upgrade
 * banner. See RELEASING.md.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const PKG = join(ROOT, 'package.json');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const DEFAULT_BRANCH = 'main';

type Bump = 'patch' | 'minor' | 'major';

function die(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function has(cmd: string): boolean {
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

function nextVersion(cur: string, bump: Bump): string {
  const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) die(`package.json version "${cur}" is not a plain x.y.z semver`);
  let [maj, min, pat] = [Number(m![1]), Number(m![2]), Number(m![3])];
  if (bump === 'major') { maj++; min = 0; pat = 0; }
  else if (bump === 'minor') { min++; pat = 0; }
  else { pat++; }
  return `${maj}.${min}.${pat}`;
}

/** Roll [Unreleased] → [version] - date in the changelog. Returns the section
 *  body (the release notes). */
function rollChangelog(version: string, date: string): string {
  const md = readFileSync(CHANGELOG, 'utf8');
  const lines = md.split('\n');
  const unrel = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (unrel === -1) die('CHANGELOG.md has no "## [Unreleased]" section');

  let next = lines.length;
  for (let i = unrel + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) { next = i; break; }
  }
  const body = lines.slice(unrel + 1, next).join('\n').trim();
  if (!body) {
    die('Nothing under [Unreleased] — add changelog entries before releasing.');
  }

  const rebuilt = [
    ...lines.slice(0, unrel),
    '## [Unreleased]',
    '',
    `## [${version}] - ${date}`,
    '',
    body,
    '',
    ...lines.slice(next),
  ].join('\n');
  writeFileSync(CHANGELOG, rebuilt);
  return body;
}

// ── main ──────────────────────────────────────────────────────────────
const bump = process.argv[2] as Bump | undefined;
if (!bump || !['patch', 'minor', 'major'].includes(bump)) {
  die('usage: pnpm release <patch|minor|major>');
}

const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch !== DEFAULT_BRANCH) {
  die(`on branch "${branch}", expected "${DEFAULT_BRANCH}". Switch first.`);
}
if (sh('git status --porcelain')) {
  die('working tree is dirty — commit or stash first.');
}

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const cur: string = pkg.version;
const version = nextVersion(cur, bump!);
const tag = `v${version}`;
const date = new Date().toISOString().slice(0, 10);

console.log(`\n  Releasing ${cur} → ${version}  (${bump})\n`);

const notes = rollChangelog(version, date);
pkg.version = version;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

sh('git add package.json CHANGELOG.md');
sh(`git commit -q -m "Release ${tag}"`);
sh(`git tag -a ${tag} -m "${tag}"`);
sh('git push -q --follow-tags');
console.log(`  ✓ committed, tagged ${tag}, pushed`);

if (has('gh --version')) {
  const dir = mkdtempSync(join(tmpdir(), 'kn-rel-'));
  const notesFile = join(dir, 'notes.md');
  writeFileSync(notesFile, notes);
  execSync(`gh release create ${tag} --title ${tag} --notes-file "${notesFile}"`,
    { stdio: 'inherit' });
  console.log(`  ✓ GitHub Release ${tag} created`);
} else {
  console.log(`\n  ! gh CLI not found — create the GitHub Release manually:`);
  console.log(`    gh release create ${tag} --title ${tag} --notes-file <(sed -n '/## \\[${version}\\]/,/## \\[/p' CHANGELOG.md)`);
}

console.log(`\n  Done. The cloud deploy will publish version.json for ${version}.\n`);
