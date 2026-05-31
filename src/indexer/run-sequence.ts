// Sequential runner for aggregate pnpm scripts. Replaces the old
// `pnpm a && pnpm b && pnpm c` chain so trailing CLI args (`--library X`,
// `--limit 50`, etc.) reach EVERY sub-step instead of only the last one.
//
// Usage in package.json:
//   "enrich:all": "tsx src/indexer/run-sequence.ts enrich:text,enrich:faces,..."
//
// Args after pnpm's `--` separator are forwarded to each sub-step.

import { spawn } from 'node:child_process';

const [, , seqStr, ...rawForwarded] = process.argv;

if (!seqStr) {
  console.error('Usage: run-sequence <comma-separated-script-ids> [-- args...]');
  process.exit(2);
}

const scripts = seqStr.split(',').map((s) => s.trim()).filter(Boolean);
// pnpm sometimes passes its own `--` separator through; strip a leading
// one so we don't end up with `pnpm step -- -- --library foo`.
const forwardedArgs = rawForwarded[0] === '--' ? rawForwarded.slice(1) : rawForwarded;

function runStep(scriptId: string): Promise<number> {
  return new Promise((resolve) => {
    // Pass args as plain positional arguments — pnpm 9+ forwards `--` as
    // a literal token rather than stripping it, so adding our own would
    // land a bare `--` in the target script's argv and trip strict
    // parsers (e.g. enrich.ts throws on unknown tokens).
    const argv = [scriptId, ...forwardedArgs];
    const child = spawn('pnpm', argv, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? -1));
    child.on('error', (err) => {
      console.error(`[run-sequence] failed to spawn pnpm ${scriptId}:`, err.message);
      resolve(-1);
    });
  });
}

async function main() {
  for (const id of scripts) {
    process.stdout.write(`\n──── ${id} ────\n`);
    const code = await runStep(id);
    if (code !== 0) {
      console.error(`\n[run-sequence] aborted: \`${id}\` exited with code ${code}`);
      process.exit(code);
    }
  }
}

main();
