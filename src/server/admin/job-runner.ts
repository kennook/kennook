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
  requeueJob,
  isQueuePaused,
  setQueuePaused,
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
import { getRawSqlite } from '@/db/client';
import { buildStorageRouter, markStorageIndexed } from '@/server/storage';

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
  /** Jobs being gracefully stopped by a pause — requeued (not finished) on exit. */
  pauseSignalFor: Set<number>;
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
  pauseSignalFor: new Set(),
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
 *   For script-based jobs:  ['tsx', '<script>', '--library', 'foo', '--limit', '50']
 *   For compose aggregates: ['pnpm', '<id>',    '--library', 'foo']
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
    // pnpm 9+ forwards `--` as a literal token rather than stripping it,
    // so we DON'T add a `--` separator here — the script's parseArgs
    // would otherwise see a bare `--` in argv and reject it. Args are
    // forwarded as plain positional arguments; pnpm passes them through
    // to the underlying script verbatim.
    return { cmd: 'pnpm', argv: [def.id, ...allArgs] };
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
    // Honor the global pause flag — don't advance the queue while paused.
    // Keep polling so resume is picked up promptly.
    if (isQueuePaused()) {
      state.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
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
    if (isQueuePaused()) { startWorkerLoop(); return; }
    const next = nextQueuedJob();
    if (next) {
      startJob(next);
    } else {
      startWorkerLoop();
    }
  }, 25);
}

function startJob(job: AdminJobRow): void {
  // Atomically claim the job FIRST. If another process (or a racing tick in
  // this one) already moved it out of 'queued', we lost — bail without
  // spawning so we don't run the job twice. Claiming before buildSpawnArgs
  // means a bad-definition failure is still attributed to the job we own.
  if (!markRunning(job.id)) {
    scheduleTickNow();
    return;
  }
  state.runningJobId = job.id;

  let cmd: string; let argv: string[];
  try {
    ({ cmd, argv } = buildSpawnArgs(job));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput(job.id, `[runner error] ${msg}\n`);
    markFinished({ id: job.id, status: 'failed', exitCode: -1 });
    const e = eventsFor(job.id);
    e.emit('output', `[runner error] ${msg}\n`);
    e.emit('finished', { status: 'failed', exitCode: -1 });
    state.runningJobId = null;
    scheduleTickNow();
    return;
  }

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
  // Display-side line builder: collapses `\r`-overwrite sequences (the
  // indexer's `\r✓ N indexed…` pattern, which is a TTY trick that renders
  // as blank lines in a browser) and drops the structured `@@kennook-progress:`
  // emissions (they're already shown by the ProgressStrip card). Only the
  // *committed* (newline-terminated) lines get stored / streamed for display.
  let liveLine = '';
  const onChunk = (data: Buffer) => {
    const text = data.toString('utf8');

    // Build the cleaned chunk for the log + live stream.
    let cleaned = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        if (!liveLine.startsWith('@@kennook-progress:')) cleaned += liveLine + '\n';
        liveLine = '';
      } else if (ch === '\r') {
        liveLine = ''; // carriage return → next chars overwrite from start
      } else {
        liveLine += ch;
      }
    }
    if (cleaned) {
      appendOutput(job.id, cleaned);
      ev.emit('output', cleaned);
    }

    // Progress detection still runs against the raw (unfiltered) text so
    // `@@kennook-progress:` lines are still parsed for the ProgressStrip.
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
          library: prevProgress.currentItemLibrary,
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

    // Paused: the job was gracefully stopped to free the queue. Put it back
    // as 'queued' (done items already persisted; resume re-runs + skips them)
    // and do NOT emit 'finished' — it isn't finished, just parked.
    if (state.pauseSignalFor.has(job.id)) {
      state.pauseSignalFor.delete(job.id);
      const pausedLine = `\n[paused] stopped to free the queue — finished work saved; will resume here.\n`;
      appendOutput(job.id, pausedLine);
      ev.emit('output', pausedLine);
      requeueJob(job.id);
      ev.emit('finished', { status: 'paused', exitCode: null });
      scheduleTickNow();
      return;
    }

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

    // Bump the matching storage's last_indexed_at when an indexer run finishes
    // cleanly. Failure to do this isn't fatal — it just means the storage row
    // won't surface a fresh "Last indexed" timestamp in the admin UI.
    if (status === 'completed' && job.command === 'indexer' && job.librarySlug) {
      try {
        const targetPath = typeof job.args.path === 'string' ? job.args.path : null;
        if (targetPath) {
          const sqlite = getRawSqlite(job.librarySlug);
          const router = buildStorageRouter(sqlite);
          const match = router.findFor(targetPath);
          if (match) markStorageIndexed(sqlite, match.id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(job.id, `\n[runner] failed to bump last_indexed_at: ${msg}\n`);
      }
    }

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
  librarySlug: string | null;
  userId: number;
}): AdminJobRow {
  ensureRunnerStarted();
  const job = storeEnqueue(input);
  scheduleTickNow();
  return job;
}

/** Pause the queue: stop advancing, and gracefully stop the running job
 *  (it requeues itself, preserving finished work). Persisted in user.db so
 *  it survives page refresh + app restart. */
export function pauseQueue(): { ok: true; running: number | null } {
  ensureRunnerStarted();
  setQueuePaused(true);
  // Gracefully stop the in-flight job so I/O frees up. The script's SIGTERM
  // handler finishes the current item then exits; the close handler sees
  // pauseSignalFor and requeues rather than marking finished.
  const runningId = state.runningJobId;
  if (runningId !== null && state.runningChild) {
    state.pauseSignalFor.add(runningId);
    state.runningChild.kill('SIGTERM');
    const child = state.runningChild;
    // Escalate if the script ignores the cooperative stop. Still safe —
    // a hard-killed item just reruns on resume.
    setTimeout(() => {
      if (state.runningJobId === runningId && !child.killed) {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }, 8000);
  }
  return { ok: true, running: runningId };
}

/** Resume the queue — clears the flag and kicks the worker. */
export function resumeQueue(): { ok: true } {
  ensureRunnerStarted();
  setQueuePaused(false);
  scheduleTickNow();
  return { ok: true };
}

/** Current paused state — read straight from the persisted flag. */
export function isPaused(): boolean {
  return isQueuePaused();
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
