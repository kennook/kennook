/**
 * Server upgrade — run as an admin job (`tsx scripts/upgrade.ts`) from the
 * repo root. Pulls the latest code, installs deps, and rebuilds the prod
 * bundle, streaming progress to the admin Jobs UI via the @@kennook-progress
 * protocol. On success it records the freshly-built version so the admin
 * banner can prompt a manual restart.
 *
 * The build targets a STAGING dir (KENNOOK_BUILD_STAGING=1 → .next-prod-staging
 * in next.config.mjs) so the long build never disturbs the .next-prod the live
 * server is serving from. Only at the very end do we swap staging into place
 * with quick renames — minimizing the window where the running server sees
 * churn. (The running process keeps its old build in memory until the manual
 * restart picks up the swapped-in .next-prod.)
 *
 * Any step exiting non-zero fails the job (visible in the Jobs output log).
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { emitProgress } from '@/indexer/progress';
import { setPendingRestartVersion } from '@/server/system/update';

const require = createRequire(import.meta.url);

const STAGING_DIR = '.next-prod-staging';
const PROD_DIR = '.next-prod';
const OLD_DIR = '.next-prod-old';

/** Spawn a child, stream its stdout/stderr into our own (→ the job log), and
 *  resolve on exit 0 / reject otherwise. */
function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`)),
    );
  });
}

async function main(): Promise<void> {
  const stepTotal = 3;

  emitProgress({ step: 'Pulling', stepIndex: 1, stepTotal, label: 'git pull --ff-only' });
  await run('git', ['pull', '--ff-only']);

  emitProgress({ step: 'Installing', stepIndex: 2, stepTotal, label: 'pnpm install --frozen-lockfile' });
  await run('pnpm', ['install', '--frozen-lockfile']);

  emitProgress({ step: 'Building', stepIndex: 3, stepTotal, label: 'pnpm build:prod (→ staging)' });
  // build:prod already sets KENNOOK_PROD=1; the staging flag redirects distDir
  // to .next-prod-staging so the live .next-prod is untouched during the build.
  await run('pnpm', ['build:prod'], { KENNOOK_BUILD_STAGING: '1' });

  // Swap the freshly-staged build into place. Fast renames, not a long build.
  console.log('[upgrade] swapping staged build into .next-prod');
  if (fs.existsSync(OLD_DIR)) fs.rmSync(OLD_DIR, { recursive: true, force: true });
  if (fs.existsSync(PROD_DIR)) fs.renameSync(PROD_DIR, OLD_DIR);
  fs.renameSync(STAGING_DIR, PROD_DIR);
  if (fs.existsSync(OLD_DIR)) fs.rmSync(OLD_DIR, { recursive: true, force: true });

  // Record what we built (post-pull package.json version) so the admin banner
  // flips to "restart to apply". The running process still reports its old
  // baked version until the manual restart.
  const pkg = require(path.resolve('package.json')) as { version: string };
  setPendingRestartVersion(pkg.version);

  emitProgress({ step: 'Done', stepIndex: 3, stepTotal, label: `built v${pkg.version} — restart to apply` });
  console.log(`[upgrade] complete: v${pkg.version} is built. Restart the server to run it.`);
}

main().catch((err) => {
  console.error(`[upgrade] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
