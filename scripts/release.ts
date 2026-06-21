#!/usr/bin/env tsx
/**
 * Cut a release from ALREADY-committed work:
 *
 *   pnpm release <patch|minor|major> [--no-deploy]
 *
 * Requires a clean tree and `[Unreleased]` changelog entries. For the
 * commit + release one-shot (the usual flow), use `pnpm commit` instead.
 */

import * as R from './release-lib';

const argv = process.argv.slice(2);
let bump: R.Bump | null = null;
let deploy = true;
let dryRun = false;
for (const a of argv) {
  if (a === 'patch' || a === 'minor' || a === 'major') bump = a;
  else if (a === '--no-deploy') deploy = false;
  else if (a === '--dry-run' || a === '-n') dryRun = true;
  else R.die(`unknown arg "${a}"`);
}
if (!bump) R.die('usage: pnpm release <patch|minor|major> [--no-deploy] [--dry-run]');

R.preflight({ requireClean: true });

const cur = R.readVersion();
const version = R.nextVersion(cur, bump);
const date = new Date().toISOString().slice(0, 10);

if (dryRun) {
  const notes = R.rollChangelog(version, date, null, false); // no write
  console.log(`\n  DRY RUN — nothing changed.`);
  console.log(`  version: ${cur} → ${version}  (${bump}),  deploy: ${deploy ? 'yes' : 'no'}`);
  console.log(`  release notes:\n${notes.split('\n').map((l) => '    ' + l).join('\n')}\n`);
  process.exit(0);
}

console.log(`\n  Releasing ${cur} → ${version}  (${bump})\n`);

const notes = R.rollChangelog(version, date, null); // require [Unreleased] content
R.writeVersion(version);
R.git('add', 'package.json', 'CHANGELOG.md');
R.git('commit', '-q', '-m', `Release v${version}`);
R.tagAnnotated(version);
R.pushWithTags();
console.log(`  ✓ committed, tagged v${version}, pushed`);

R.createGithubRelease(version, notes);
if (deploy) R.triggerCloudDeploy();

console.log(`\n  Done — released v${version}.\n`);
