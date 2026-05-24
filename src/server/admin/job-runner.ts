/**
 * Admin job runner — single-process worker that drains the queue
 * one job at a time.
 *
 * Concurrency: one job globally. Per the operator's call (don't want
 * to crash the machine via concurrent Florence-2 + face-api + CLIP),
 * jobs run sequentially. The DB queue is the source of truth, so
 * multiple admins can enqueue without coordination and see the same
 * pending list.
 *
 * Subscriber model: an in-process EventEmitter fans output chunks
 * out to whichever SSE connections are tailing a given job id.
 * Subscriptions are by job id; outputs aren't fanned across jobs.
 *
 * Lifecycle: `ensureRunnerStarted()` lazily boots on first import.
 * Idempotent — safe to call from every API route.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  enqueueJob as storeEnqueue,
  nextQueuedJob,
  markRunning,
  appendOutput,
  setProgress,
  markFinished,
  cancelQueuedJob,
  getJob,
  reapOrphanedRunningJobs,
  type AdminJobRow,
} from './job-store';
import { getJobDefinition } from './job-catalog';
import {
  parseProgressLine,
  type ProgressPayload,
  type RecentItem,
} from './progress-protocol';

// How many recently-processed items to keep in the rolling buffer per
// job. Sized for the UI's strip (8 visible + a small overscan).
const RECENT_BUFFER_SIZE = 12;

// All runner state lives on globalThis so it SURVIVES Next.js dev-mode
// HMR. Otherwise hot-reloading any file in the import graph would
// create a fresh module instance with a new EventEmitter map — the
// running child process would keep piping into the OLD module's
// emitter (which has no subscribers), and SSE clients connecting to
// the NEW module would never see any events until a full reload.
//
// Even after a full page reload, the in-memory state drift can mean
// the new SSE finds an empty emitter (the events queue lives on the
// stale module). globalThis-pinning makes the singleton resilient.
class JobEvents extends EventEmitter {}
type RunnerChild = ChildProcessByStdio<null, Readable, Readable>;

interface RunnerGlobals {
  events: Map<number, JobEvents>;
  recentBuffers: Map<number, RecentItem[]>;
  cancelSignalFor: Set<number>;
  runningJobId: number | null;
  runningChild: RunnerChild | null;
  workerStarted: boolean;
  pollTimer: NodeJS.Timeout | null;
}

const G = globalThis as typeof globalThis & {
  __kennookAdminRunner?: RunnerGlobals;
};
const state: RunnerGlobals = G.__kennookAdminRunner ?? (G.__kennookAdminRunner = {
  events: new Map(),
  recentBuffers: new Map(),
  cancelSignalFor: new Set(),
  runningJobId: null,
  runningChild: null,
  workerStarted: false,
  pollTimer: null,
});

// Per-job event channel. Events:
//   'output'   (chunk: string)
//   'progress' (ProgressEnvelope)
//   'finished' (status, exitCode)
function eventsFor(jobId: number): JobEvents {
  let e = state.events.get(jobId);
  if (!e) { e = new JobEvents(); state.events.set(jobId, e); }
  e.setMaxListeners(100);
  return e;
}

// Per-job rolling buffer of recently-processed items. Ephemeral —
// not persisted. Cleared when a job finishes. Each entry is the
// *previous* item the script was working on, promoted when the next
// progress emit arrives.
function recentFor(jobId: number): RecentItem[] {
  let buf = state.recentBuffers.get(jobId);
  if (!buf) { buf = []; state.recentBuffers.set(jobId, buf); }
  return buf;
}
/** Snapshot copy — callers can mutate without affecting the buffer. */
export function getRecentItems(jobId: number): RecentItem[] {
  return [...(state.recentBuffers.get(jobId) ?? [])];
}

const POLL_INTERVAL_MS = 1500;

/**
 * Build the argv passed to the child process from a job definition + args.
 *
 *   For script-based jobs:  ['tsx', '<script>', '--workspace', 'foo', '--limit', '50']
 *   For compose aggregates: ['pnpm', '<id>',    '--workspace', 'foo']
 */
function buildSpawnArgs(job: AdminJobRow): { cmd: string; argv: string[] } {
  const def = getJobDefinition(job.command);
  if (!def) throw new Error(`Unknown job command: ${job.command}`);

  // Two buckets: --flag args (emitted first) and positional args
  // (emitted after, in catalog-declaration order). Most scripts'
  // argparsers accept flags before positionals.
  const flagArgs: string[] = [];
  const positionalArgs: string[] = [];
  for (const opt of def.options) {
    const value = job.args[opt.flag];
    if (value === undefined || value === '' || value === null) continue;
    if (opt.type === 'boolean') {
      if (value === true || value === 'true') flagArgs.push(`--${opt.flag}`);
      continue;
    }
    if (opt.positional) {
      positionalArgs.push(String(value));
    } else {
      flagArgs.push(`--${opt.flag}`, String(value));
    }
  }
  const allArgs = [...flagArgs, ...positionalArgs];

  if (def.compose) {
    // pnpm forwards everything after `--` to the script. We use the
    // pnpm script name (which equals the job id) for compose entries
    // so the package.json's `&&`-chained command runs intact.
    return { cmd: 'pnpm', argv: [def.id, ...(allArgs.length ? ['--', ...allArgs] : [])] };
  }
  if (!def.script) throw new Error(`Job ${def.id} has neither script nor compose set`);
  return { cmd: 'pnpm', argv: ['exec', 'tsx', def.script, ...allArgs] };
}

function startWorkerLoop(): void {
  if (state.pollTimer) return;
  const tick = () => {
    state.pollTimer = null;
    if (state.runningJobId !== null) {
      // Worker is busy — re-check after current job finishes (handled
      // by the child's 'close' event scheduling the next tick).
      return;
    }
    const next = nextQueuedJob();
    if (!next) {
      // Idle — poll again later.
      state.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    startJob(next);
    // After startJob, runningJobId is set; the close handler schedules
    // the next tick.
  };
  state.pollTimer = setTimeout(tick, 50);
}

function scheduleTickNow(): void {
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    if (state.runningJobId !== null) return;
    const next = nextQueuedJob();
    if (next) {
      startJob(next);
    } else {
      startWorkerLoop();
    }
  }, 25);
}

function startJob(job: AdminJobRow): void {
  let cmd: string; let argv: string[];
  try {
    ({ cmd, argv } = buildSpawnArgs(job));
  } catch (err) {
    markRunning(job.id);
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput(job.id, `[runner error] ${msg}\n`);
    markFinished({ id: job.id, status: 'failed', exitCode: -1 });
    const e = eventsFor(job.id);
    e.emit('output', `[runner error] ${msg}\n`);
    e.emit('finished', { status: 'failed', exitCode: -1 });
    scheduleTickNow();
    return;
  }

  markRunning(job.id);
  state.runningJobId = job.id;
  const ev = eventsFor(job.id);

  // Emit banner BEFORE spawn so even synchronous spawn errors surface
  // alongside what we were trying to run. Includes cwd + PATH head
  // for quick troubleshooting when a binary isn't found.
  const cwd = process.cwd();
  const pathHead = (process.env.PATH ?? '').split(':').slice(0, 4).join(':');
  const banner =
    `$ ${cmd} ${argv.join(' ')}\n` +
    `[cwd] ${cwd}\n` +
    `[path] ${pathHead}${pathHead ? '…' : '(empty)'}\n`;
  appendOutput(job.id, banner);
  ev.emit('output', banner);

  let child: RunnerChild;
  try {
    child = spawn(cmd, argv, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Synchronous spawn failures (rare but possible — e.g. ENOENT on
    // some Node versions surfaces here instead of via 'error' event).
    const msg = `[spawn threw] ${err instanceof Error ? err.message : String(err)}\n`;
    appendOutput(job.id, msg);
    ev.emit('output', msg);
    markFinished({ id: job.id, status: 'failed', exitCode: -1 });
    ev.emit('finished', { status: 'failed', exitCode: -1 });
    state.runningJobId = null;
    state.runningChild = null;
    scheduleTickNow();
    return;
  }
  state.runningChild = child;

  // Line buffering for progress detection. The protocol is per-line
  // (one JSON object per `@@kennook-progress:` line); chunks from
  // child stdout often split mid-line, so we buffer the trailing
  // partial line and parse only completed lines.
  //
  // Recent-items buffer: scripts emit BEFORE processing each item
  // ("about to do X"). So when a new emit arrives, the *previous*
  // emit's item has just finished — that's when we promote it into
  // the rolling buffer.
  let lineBuf = '';
  let prevProgress: ProgressPayload | null = null;
  const onChunk = (data: Buffer) => {
    const text = data.toString('utf8');
    appendOutput(job.id, text);
    ev.emit('output', text);

    lineBuf += text;
    let nl;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const progress = parseProgressLine(line);
      if (!progress) continue;

      // Promote the previous item into the rolling buffer when the
      // currentItem changes — same item across consecutive emits
      // means just an in-place update (e.g. label refresh), not a
      // new item finishing.
      if (
        prevProgress?.currentItem &&
        prevProgress.currentItem !== progress.currentItem
      ) {
        const buf = recentFor(job.id);
        buf.unshift({
          item: prevProgress.currentItem,
          kind: prevProgress.currentItemKind ?? 'path',
          workspace: prevProgress.currentItemWorkspace,
          label: prevProgress.label,
          at: Date.now(),
        });
        if (buf.length > RECENT_BUFFER_SIZE) buf.length = RECENT_BUFFER_SIZE;
      }
      prevProgress = progress;

      setProgress(job.id, progress);
      ev.emit('progress', { progress, recent: [...recentFor(job.id)] });
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  // 'error' fires for failed spawn (ENOENT, EACCES) and IPC issues.
  // We surface but DON'T mark finished here — 'close' will follow and
  // owns the status transition.
  child.on('error', (err) => {
    const msg = `[spawn error] ${err.message}\n`;
    appendOutput(job.id, msg);
    ev.emit('output', msg);
  });

  child.on('close', (code, signal) => {
    state.runningJobId = null;
    state.runningChild = null;
    // Recent-items buffer is alive-job state — drop it once the job
    // is done. Late-joining tabs after this point get an empty strip,
    // which is correct (the job is no longer scanning anything).
    state.recentBuffers.delete(job.id);

    // Always log a final exit line so the operator sees SOMETHING even
    // when the script itself produced no output.
    const exitLine = `\n[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}\n`;
    appendOutput(job.id, exitLine);
    ev.emit('output', exitLine);

    // Distinguish canceled (got SIGTERM via our cancel API) from
    // organic failure. The cancel endpoint sets a flag before sending
    // the signal; we read that here.
    let status: 'completed' | 'failed' | 'canceled';
    if (state.cancelSignalFor.has(job.id)) {
      status = 'canceled';
      state.cancelSignalFor.delete(job.id);
    } else if (code === 0) {
      status = 'completed';
    } else {
      status = 'failed';
    }
    const exitCode = code ?? (signal ? -2 : -1);
    markFinished({ id: job.id, status, exitCode });
    ev.emit('finished', { status, exitCode });
    scheduleTickNow();
  });
}

/** Boot the worker once — idempotent. */
export function ensureRunnerStarted(): void {
  if (state.workerStarted) return;
  state.workerStarted = true;
  const reaped = reapOrphanedRunningJobs();
  if (reaped > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[admin-jobs] reaped ${reaped} orphaned running job(s) on boot`);
  }
  startWorkerLoop();
}

/** Public API surface used by the route handlers. */

export function enqueue(input: {
  command: string;
  args: Record<string, string | number | boolean>;
  workspaceSlug: string | null;
  userId: number;
}): AdminJobRow {
  ensureRunnerStarted();
  const job = storeEnqueue(input);
  scheduleTickNow();
  return job;
}

export function cancel(jobId: number): { ok: boolean; reason?: string } {
  ensureRunnerStarted();
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: 'not found' };
  if (job.status === 'queued') {
    const ok = cancelQueuedJob(jobId);
    return ok ? { ok: true } : { ok: false, reason: 'race — job already started' };
  }
  if (job.status === 'running') {
    if (state.runningJobId !== jobId || !state.runningChild) {
      return { ok: false, reason: 'no live process for this job' };
    }
    state.cancelSignalFor.add(jobId);
    state.runningChild.kill('SIGTERM');
    // Escalate after a short grace period if it ignores SIGTERM.
    const child = state.runningChild;
    setTimeout(() => {
      if (state.runningJobId === jobId && !child.killed) {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }, 3000);
    return { ok: true };
  }
  return { ok: false, reason: `cannot cancel a ${job.status} job` };
}

/** SSE-style subscription for live output. Returns an unsubscribe fn. */
export function subscribe(
  jobId: number,
  handlers: {
    onOutput: (chunk: string) => void;
    onProgress?: (envelope: { progress: ProgressPayload; recent: RecentItem[] }) => void;
    onFinished: (info: { status: string; exitCode: number | null }) => void;
  },
): () => void {
  const ev = eventsFor(jobId);
  ev.on('output', handlers.onOutput);
  if (handlers.onProgress) ev.on('progress', handlers.onProgress);
  ev.on('finished', handlers.onFinished);
  return () => {
    ev.off('output', handlers.onOutput);
    if (handlers.onProgress) ev.off('progress', handlers.onProgress);
    ev.off('finished', handlers.onFinished);
  };
}

/** Currently-running job id (for UI badges / "currently executing"). */
export function currentlyRunningJobId(): number | null {
  return state.runningJobId;
}
