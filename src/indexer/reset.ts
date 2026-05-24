// Reset (empty) a workspace's data — deletes its SQLite DB + thumbnails, but
// leaves the workspace entry in the registry. On the next app/indexer access,
// the DB is re-created empty by getRawSqlite's auto-init.
//
// Usage:
//   pnpm reset                                # empty 'personal' (asks to confirm)
//   pnpm reset --workspace work               # empty a specific workspace
//   pnpm reset --all                          # empty every workspace
//   pnpm reset --force --workspace work       # skip the confirmation prompt
//
// To fully remove a workspace from the registry (not just empty it), edit
// data/workspaces.json by hand for now.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import {
  DEFAULT_WORKSPACE_SLUG,
  getWorkspaceBySlug,
  listWorkspaces,
  workspaceRoot,
} from '@/server/workspaces';

interface CliArgs {
  workspaceSlug: string;
  all: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let workspaceSlug = DEFAULT_WORKSPACE_SLUG;
  let all = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '-w') {
      const v = argv[++i];
      if (!v) throw new Error('--workspace requires a value');
      workspaceSlug = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceSlug = a.split('=')[1];
    } else if (a === '--all') {
      all = true;
    } else if (a === '--force' || a === '-f') {
      force = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  return { workspaceSlug, all, force };
}

function printHelp() {
  console.log(`Usage:
  pnpm reset                          # empty 'personal' workspace
  pnpm reset --workspace <slug>       # empty a specific workspace
  pnpm reset --all                    # empty every workspace
  pnpm reset --force [...]            # skip the confirmation prompt
`);
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message}\nType "yes" to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function resetWorkspace(slug: string): { existed: boolean; path: string } {
  const dir = workspaceRoot(slug);
  if (!fs.existsSync(dir)) return { existed: false, path: dir };
  fs.rmSync(dir, { recursive: true, force: true });
  return { existed: true, path: dir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.all) {
    const workspaces = listWorkspaces();
    if (!workspaces.length) {
      console.log('No workspaces in the registry. Nothing to reset.');
      return;
    }
    if (!args.force) {
      const ok = await confirm(
        `About to EMPTY ${workspaces.length} workspace(s):\n` +
          workspaces.map((w) => `  - ${w.name} (${w.slug})`).join('\n') +
          '\nAll indexed media, embeddings, and thumbnails in these workspaces will be lost.',
      );
      if (!ok) {
        console.log('Cancelled.');
        return;
      }
    }
    for (const ws of workspaces) {
      const r = resetWorkspace(ws.slug);
      console.log(r.existed ? `✓ Cleared ${r.path}` : `↷ Skipped ${r.path} (didn't exist)`);
    }
  } else {
    const ws = getWorkspaceBySlug(args.workspaceSlug);
    if (!ws) {
      console.error(`Workspace "${args.workspaceSlug}" not found in the registry.`);
      console.error('Run with --all to clear everything, or check data/workspaces.json.');
      process.exit(1);
    }
    if (!args.force) {
      const ok = await confirm(
        `About to EMPTY workspace "${ws.name}" (${ws.slug}).\n` +
          'All indexed media, embeddings, and thumbnails in this workspace will be lost.',
      );
      if (!ok) {
        console.log('Cancelled.');
        return;
      }
    }
    const r = resetWorkspace(ws.slug);
    console.log(r.existed ? `✓ Cleared ${r.path}` : `↷ Nothing at ${r.path} — already empty.`);
  }

  console.log(
    '\nDone. The workspace(s) will be auto-initialized empty on the next app or indexer access.',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
