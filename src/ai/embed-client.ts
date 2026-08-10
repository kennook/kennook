import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { embedText as embedTextInProcess } from './embeddings';

/**
 * Main-thread client for the embed worker (src/ai/embed-worker.ts). Routes CLIP
 * text embeddings through a persistent child process so ONNX inference never
 * blocks the server event loop (which serves thumbnails, every window, and SSE).
 *
 * - One long-lived worker, spawned lazily and kept warm.
 * - Small LRU by exact text: a single user search embeds the SAME query twice
 *   (once for ranked results, once for facet counts), and multiple windows often
 *   search the same term — one inference serves them all. Embeddings are
 *   deterministic, so caching by text is safe.
 * - Fail-safe: if the worker can't spawn, dies, or times out, we fall back to
 *   in-process embedding (degraded — it blocks the loop — but search still
 *   works). When it works, nothing about the result changes; only WHERE the
 *   inference runs does.
 *
 * State lives on `globalThis` so Next's dev HMR (which re-evaluates modules)
 * reuses the one running worker instead of orphaning a model-holding process on
 * every reload.
 */

const WORKER_PATH = path.join(process.cwd(), 'src/ai/embed-worker.ts');
const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_MAX = 64;

type Pending = { resolve: (v: Float32Array) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Store = {
  child: ChildProcess | null;
  nextId: number;
  pending: Map<number, Pending>;
  cache: Map<string, Promise<Float32Array>>;
  exitHooked: boolean;
};

const g = globalThis as typeof globalThis & { __knEmbedWorker?: Store };
const store: Store = (g.__knEmbedWorker ??= {
  child: null, nextId: 1, pending: new Map(), cache: new Map(), exitHooked: false,
});

if (!store.exitHooked) {
  store.exitHooked = true;
  // Don't leave an orphaned worker behind if the server process exits.
  process.on('exit', () => { try { store.child?.kill(); } catch { /* best-effort */ } });
}

function settleAllRejected(reason: string): void {
  for (const [, p] of store.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
  store.pending.clear();
}

function spawnWorker(): ChildProcess | null {
  try {
    // `node --import tsx <file.ts>` runs the TS worker with a real IPC channel
    // straight to node (no pnpm/shell layer to lose fd 3 through). tsx is present
    // in prod because the job runner already depends on it there.
    const c = spawn(process.execPath, ['--import', 'tsx', WORKER_PATH], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });
    c.on('message', (msg: { id?: number; ok?: boolean; embedding?: number[]; error?: string; ready?: boolean }) => {
      if (msg.ready || msg.id == null) return;
      const p = store.pending.get(msg.id);
      if (!p) return;
      store.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok && msg.embedding) p.resolve(Float32Array.from(msg.embedding));
      else p.reject(new Error(msg.error ?? 'embed worker error'));
    });
    const onDead = () => { if (store.child === c) store.child = null; settleAllRejected('embed worker exited'); };
    c.on('exit', onDead);
    c.on('error', onDead);
    return c;
  } catch {
    return null;
  }
}

function ensureWorker(): ChildProcess | null {
  if (store.child && store.child.connected) return store.child;
  store.child = spawnWorker();
  return store.child;
}

function embedViaWorker(text: string): Promise<Float32Array> {
  const c = ensureWorker();
  if (!c || !c.connected) return embedTextInProcess(text); // couldn't spawn → degrade
  const id = store.nextId++;
  return new Promise<Float32Array>((resolve, reject) => {
    const timer = setTimeout(() => { store.pending.delete(id); reject(new Error('embed worker timeout')); }, REQUEST_TIMEOUT_MS);
    store.pending.set(id, { resolve, reject, timer });
    try {
      c.send({ id, text });
    } catch (err) {
      clearTimeout(timer);
      store.pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  }).catch(() => embedTextInProcess(text)); // any worker failure → in-process
}

export function embedTextOffThread(text: string): Promise<Float32Array> {
  const { cache } = store;
  const hit = cache.get(text);
  if (hit) { cache.delete(text); cache.set(text, hit); return hit; } // bump recency
  const p = embedViaWorker(text);
  cache.set(text, p);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  p.catch(() => { if (cache.get(text) === p) cache.delete(text); }); // never cache a hard failure
  return p;
}

/** Pre-spawn + warm the worker at server startup (see instrumentation.ts). */
export function warmEmbedWorker(): void { ensureWorker(); }
