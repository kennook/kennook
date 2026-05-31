// Reset (empty) a library's data — deletes its SQLite DB + thumbnails, but
// leaves the library entry in the registry. On the next app/indexer access,
// the DB is re-created empty by getRawSqlite's auto-init.
//
// Usage:
//   pnpm reset                                # empty 'personal' (asks to confirm)
//   pnpm reset --library work               # empty a specific library
//   pnpm reset --all                          # empty every library
//   pnpm reset --force --library work       # skip the confirmation prompt
//
// To fully remove a library from the registry (not just empty it), edit
// data/libraries.json by hand for now.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import {
  DEFAULT_LIBRARY_SLUG,
  getLibraryBySlug,
  listLibraries,
  libraryRoot,
} from '@/server/libraries';

interface CliArgs {
  librarySlug: string;
  all: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let librarySlug = DEFAULT_LIBRARY_SLUG;
  let all = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library' || a === '-w') {
      const v = argv[++i];
      if (!v) throw new Error('--library requires a value');
      librarySlug = v;
    } else if (a.startsWith('--library=')) {
      librarySlug = a.split('=')[1];
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

  return { librarySlug, all, force };
}

function printHelp() {
  console.log(`Usage:
  pnpm reset                          # empty 'personal' library
  pnpm reset --library <slug>       # empty a specific library
  pnpm reset --all                    # empty every library
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

function resetLibrary(slug: string): { existed: boolean; path: string } {
  const dir = libraryRoot(slug);
  if (!fs.existsSync(dir)) return { existed: false, path: dir };
  fs.rmSync(dir, { recursive: true, force: true });
  return { existed: true, path: dir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.all) {
    const libraries = listLibraries();
    if (!libraries.length) {
      console.log('No libraries in the registry. Nothing to reset.');
      return;
    }
    if (!args.force) {
      const ok = await confirm(
        `About to EMPTY ${libraries.length} library(s):\n` +
          libraries.map((w) => `  - ${w.name} (${w.slug})`).join('\n') +
          '\nAll indexed media, embeddings, and thumbnails in these libraries will be lost.',
      );
      if (!ok) {
        console.log('Cancelled.');
        return;
      }
    }
    for (const ws of libraries) {
      const r = resetLibrary(ws.slug);
      console.log(r.existed ? `✓ Cleared ${r.path}` : `↷ Skipped ${r.path} (didn't exist)`);
    }
  } else {
    const ws = getLibraryBySlug(args.librarySlug);
    if (!ws) {
      console.error(`Library "${args.librarySlug}" not found in the registry.`);
      console.error('Run with --all to clear everything, or check data/libraries.json.');
      process.exit(1);
    }
    if (!args.force) {
      const ok = await confirm(
        `About to EMPTY library "${ws.name}" (${ws.slug}).\n` +
          'All indexed media, embeddings, and thumbnails in this library will be lost.',
      );
      if (!ok) {
        console.log('Cancelled.');
        return;
      }
    }
    const r = resetLibrary(ws.slug);
    console.log(r.existed ? `✓ Cleared ${r.path}` : `↷ Nothing at ${r.path} — already empty.`);
  }

  console.log(
    '\nDone. The library(s) will be auto-initialized empty on the next app or indexer access.',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
