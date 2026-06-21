/**
 * Shared release machinery for `pnpm commit` (scripts/commit.ts) and
 * `pnpm release` (scripts/release.ts). One source of truth for version bumps,
 * changelog rolling, tagging, the GitHub Release, and the cloud deploy.
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const ROOT = process.cwd();
export const PKG = join(ROOT, 'package.json');
export const CHANGELOG = join(ROOT, 'CHANGELOG.md');
export const DEFAULT_BRANCH = 'main';
export const CLOUD_REPO = 'kennook/kennook-cloud';
export const CLOUD_DEPLOY_WORKFLOW = 'deploy-prod.yml';

export type Bump = 'patch' | 'minor' | 'major';

export function die(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

/** Run a git command via arg array (no shell → injection/quoting-safe). */
export function git(...args: string[]): string {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

/** Run a shell command, returning trimmed stdout. */
export function sh(cmd: string): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

export function has(cmd: string): boolean {
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

export function readVersion(): string {
  return JSON.parse(readFileSync(PKG, 'utf8')).version as string;
}

export function nextVersion(cur: string, bump: Bump): string {
  const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) die(`package.json version "${cur}" is not a plain x.y.z semver`);
  let [maj, min, pat] = [Number(m![1]), Number(m![2]), Number(m![3])];
  if (bump === 'major') { maj++; min = 0; pat = 0; }
  else if (bump === 'minor') { min++; pat = 0; }
  else { pat++; }
  return `${maj}.${min}.${pat}`;
}

export function writeVersion(version: string): void {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  pkg.version = version;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
}

/**
 * Pre-flight, run BEFORE any mutation so a bad state aborts cleanly instead of
 * leaving a half-cut release. Always: on the default branch, origin reachable,
 * and not behind origin. `requireClean` additionally demands a clean tree
 * (release.ts) — commit.ts skips that since it's about to stage changes.
 */
export function preflight(opts: { requireClean: boolean }): void {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== DEFAULT_BRANCH) {
    die(`on branch "${branch}", expected "${DEFAULT_BRANCH}". Switch first.`);
  }
  if (opts.requireClean && git('status', '--porcelain')) {
    die('working tree is dirty — commit or stash first.');
  }
  try { git('fetch', '--quiet', 'origin'); }
  catch { die('could not reach origin — check your network/remote.'); }
  const behind = git('rev-list', '--count', `HEAD..origin/${DEFAULT_BRANCH}`);
  if (behind !== '0') {
    die(`origin/${DEFAULT_BRANCH} has ${behind} commit(s) you don't have. Run "git pull --rebase" first, then re-run.`);
  }
}

/**
 * Roll CHANGELOG `[Unreleased]` into a dated `[version]` section. If
 * `[Unreleased]` is empty and `fallbackNote` is given, that note becomes the
 * section's single bullet (so a quick commit still produces release notes).
 * Returns the section body (used as the GitHub Release notes).
 */
export function rollChangelog(
  version: string, date: string, fallbackNote: string | null, write = true,
): string {
  const md = readFileSync(CHANGELOG, 'utf8');
  const lines = md.split('\n');
  const unrel = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (unrel === -1) die('CHANGELOG.md has no "## [Unreleased]" section');

  let next = lines.length;
  for (let i = unrel + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) { next = i; break; }
  }
  let body = lines.slice(unrel + 1, next).join('\n').trim();
  if (!body) {
    if (!fallbackNote) {
      die('Nothing under [Unreleased] — add changelog entries before releasing.');
    }
    body = `- ${fallbackNote}`;
  }

  if (write) {
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
  }
  return body;
}

export function tagAnnotated(version: string): void {
  git('tag', '-a', `v${version}`, '-m', `v${version}`);
}

export function pushWithTags(): void {
  try { git('push', '-q', '--follow-tags'); }
  catch {
    die(`push failed. Your commit + tag v${readVersion()} are LOCAL — once origin is sorted, run "git push --follow-tags".`);
  }
}

export function createGithubRelease(version: string, notes: string): void {
  const tag = `v${version}`;
  if (!has('gh --version')) {
    console.log(`  ! gh CLI not found — create the Release manually: gh release create ${tag} --notes-file <changelog section>`);
    return;
  }
  const f = join(mkdtempSync(join(tmpdir(), 'kn-rel-')), 'notes.md');
  writeFileSync(f, notes);
  execFileSync('gh', ['release', 'create', tag, '--title', tag, '--notes-file', f], { stdio: 'inherit' });
  console.log(`  ✓ GitHub Release ${tag}`);
}

/** Fire the cloud deploy (republishes kennook.com/version.json). Async in CI;
 *  we don't block on it. */
export function triggerCloudDeploy(): void {
  if (!has('gh --version')) {
    console.log(`  ! gh CLI not found — deploy version.json manually (push kennook-cloud or run its deploy workflow).`);
    return;
  }
  try {
    execFileSync('gh', ['workflow', 'run', CLOUD_DEPLOY_WORKFLOW, '-R', CLOUD_REPO, '--ref', 'main'], { stdio: 'inherit' });
    console.log(`  ✓ cloud deploy triggered (publishes version.json in ~a few min)`);
  } catch {
    console.log(`  ! couldn't trigger the cloud deploy — run it manually when ready.`);
  }
}
