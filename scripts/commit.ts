#!/usr/bin/env tsx
/**
 * Commit + release in one step. The constant-release workflow:
 *
 *   pnpm commit "message"            # patch release (default)
 *   pnpm commit "message" --minor    # minor release
 *   pnpm commit "message" --major    # major release
 *   pnpm commit "message" --no-deploy # skip the cloud deploy
 *
 * What it does, in order:
 *   1. Pre-flight (on main, origin reachable, not behind) — BEFORE anything
 *      changes, so a bad state aborts cleanly.
 *   2. Stage everything and bump the version.
 *   3. Roll the changelog — your `[Unreleased]` entries if any, else the
 *      commit message becomes the release note.
 *   4. ONE commit (your message + the version bump + changelog), annotated
 *      tag, push.
 *   5. Create the GitHub Release.
 *   6. Trigger the cloud deploy so kennook.com/version.json republishes
 *      (unless --no-deploy).
 *
 * Safe to run constantly: the pre-flight + fast-forward push mean it won't
 * leave a half-cut release behind.
 */

import * as R from './release-lib';

const argv = process.argv.slice(2);
let bump: R.Bump = 'patch';
let deploy = true;
let dryRun = false;
const words: string[] = [];
for (const a of argv) {
  if (a === '--minor') bump = 'minor';
  else if (a === '--major') bump = 'major';
  else if (a === '--patch') bump = 'patch';
  else if (a === '--no-deploy') deploy = false;
  else if (a === '--dry-run' || a === '-n') dryRun = true;
  else if (a.startsWith('--')) R.die(`unknown flag "${a}"`);
  else words.push(a);
}
const message = words.join(' ').trim();
if (!message) {
  R.die('usage: pnpm commit "<message>" [--minor|--major] [--no-deploy] [--dry-run]');
}

// 1. Pre-flight (no clean-tree requirement — we're about to stage).
R.preflight({ requireClean: false });

const cur = R.readVersion();
const version = R.nextVersion(cur, bump);
const date = new Date().toISOString().slice(0, 10);

if (dryRun) {
  if (!R.git('status', '--porcelain')) R.die('nothing to commit — make some changes first.');
  const notes = R.rollChangelog(version, date, message, false); // no write
  console.log(`\n  DRY RUN — nothing changed.\n`);
  console.log(`  message:  ${message}`);
  console.log(`  version:  ${cur} → ${version}  (${bump})`);
  console.log(`  deploy:   ${deploy ? 'yes' : 'no'}`);
  console.log(`  files:\n${R.git('status', '--porcelain').split('\n').map((l) => '    ' + l).join('\n')}`);
  console.log(`  release notes:\n${notes.split('\n').map((l) => '    ' + l).join('\n')}\n`);
  process.exit(0);
}

// 2. Stage everything; bail if there's nothing to commit.
R.git('add', '-A');
if (!R.git('diff', '--cached', '--name-only')) {
  R.die('nothing to commit — make some changes first.');
}

console.log(`\n  ${message}\n  ${cur} → ${version}  (${bump})\n`);

// 3. Changelog: curated [Unreleased] entries win, else use the message.
const notes = R.rollChangelog(version, date, message);

// 4. Bump + one commit + tag + push.
R.writeVersion(version);
R.git('add', 'package.json', 'CHANGELOG.md');
R.git('commit', '-q', '-m', message);
R.tagAnnotated(version);
R.pushWithTags();
console.log(`  ✓ committed, tagged v${version}, pushed`);

// 5 + 6.
R.createGithubRelease(version, notes);
if (deploy) R.triggerCloudDeploy();
else console.log('  (skipped cloud deploy — version.json publishes on the next deploy)');

console.log(`\n  Released v${version}.\n`);
