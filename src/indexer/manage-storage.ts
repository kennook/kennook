// Small CLI for inspecting/modifying storage_locations in a library.
// Wraps the same helpers used by the /admin/storage UI (src/server/storage.ts)
// so behavior stays consistent.
//
// Usage:
//   pnpm storage list                              # show all storages
//   pnpm storage add <root_path> <name>            # add a local storage
//   pnpm storage remove <id>                       # remove a storage by id
//   pnpm storage set-root <id> <new_root_path>     # change a storage's root
//
// All commands accept --library/-w to target a non-default library.

import { getRawSqlite } from '@/db/client';
import { DEFAULT_LIBRARY_SLUG, resolveLibrary } from '@/server/libraries';
import {
  createStorage,
  deleteStorage,
  listStorageInfo,
  updateStorageRoot,
} from '@/server/storage';

interface Args {
  librarySlug: string;
  cmd: 'list' | 'add' | 'remove' | 'set-root';
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  let librarySlug = DEFAULT_LIBRARY_SLUG;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library' || a === '-w') {
      const v = argv[++i]; if (v) librarySlug = v;
    } else if (a.startsWith('--library=')) {
      librarySlug = a.split('=')[1];
    } else {
      positional.push(a);
    }
  }
  const cmd = positional.shift() as Args['cmd'] | undefined;
  if (!cmd || !['list', 'add', 'remove', 'set-root'].includes(cmd)) {
    console.error('usage: pnpm storage <list|add|remove|set-root> [args] [--library slug]');
    process.exit(2);
  }
  return { librarySlug, cmd, positional };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  resolveLibrary(args.librarySlug);
  const sqlite = getRawSqlite(args.librarySlug);

  try {
    switch (args.cmd) {
      case 'list': {
        const rows = listStorageInfo(sqlite);
        if (rows.length === 0) {
          console.log('(no storage locations)');
          return;
        }
        console.log(`Storage locations in library "${args.librarySlug}":\n`);
        for (const r of rows) {
          const status = r.exists === null ? 'cloud' : r.exists ? 'online' : 'MISSING';
          const tag = r.is_default ? ' [default]' : '';
          console.log(`  [${r.id}] ${r.name}${tag}`);
          console.log(`        type:   ${r.type}`);
          console.log(`        root:   ${r.root_path}   (${status})`);
          console.log(`        files:  ${r.file_count}`);
          console.log('');
        }
        break;
      }
      case 'add': {
        const [root, name] = args.positional;
        if (!root || !name) { console.error('usage: pnpm storage add <root_path> <name>'); process.exit(2); }
        const { id } = createStorage(sqlite, { name, root_path: root });
        console.log(`Added storage [${id}] "${name}" at ${root}`);
        break;
      }
      case 'remove': {
        const [idStr] = args.positional;
        const id = parseInt(idStr ?? '', 10);
        if (!id) { console.error('usage: pnpm storage remove <id>'); process.exit(2); }
        deleteStorage(sqlite, id);
        console.log(`Removed storage [${id}]`);
        break;
      }
      case 'set-root': {
        const [idStr, root] = args.positional;
        const id = parseInt(idStr ?? '', 10);
        if (!id || !root) { console.error('usage: pnpm storage set-root <id> <new_root_path>'); process.exit(2); }
        updateStorageRoot(sqlite, id, root);
        console.log(`Updated storage [${id}] root_path → ${root}`);
        console.log(`(media_items.path values are unchanged — they're already relative to the new root)`);
        break;
      }
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
