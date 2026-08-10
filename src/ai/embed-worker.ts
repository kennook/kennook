/**
 * Persistent child process: runs CLIP text embeddings OFF the server's event
 * loop.
 *
 * In-process, ONNX inference blocks the single Node event loop for the
 * ~100–300ms a query embedding takes — which freezes ALL request serving
 * (thumbnails, every open window, the SSE stream) for that whole window. That's
 * the "everything stalls during search" symptom: it was never the connection
 * limit, it's a blocked CPU. Running the inference here keeps the server's loop
 * free to serve everything else while this process computes.
 *
 * IPC protocol (process.send / 'message'):
 *   in : { id: number; text: string }
 *   out: { id: number; ok: true; embedding: number[] }
 *      | { id: number; ok: false; error: string }
 *      | { ready: true }                          // emitted once the model is warm
 *
 * Launched via `node --import tsx src/ai/embed-worker.ts` (see embed-client.ts),
 * mirroring how the job runner already runs TypeScript subprocesses in prod.
 */
import { embedText } from './embeddings';

type Req = { id: number; text: string };

process.on('message', (msg: Req) => {
  void embedText(msg.text).then(
    (vec) => process.send?.({ id: msg.id, ok: true, embedding: Array.from(vec) }),
    (err: unknown) =>
      process.send?.({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});

// If the parent (the server) goes away, the IPC channel disconnects — exit so we
// never linger as an orphan (matters across dev HMR restarts).
process.on('disconnect', () => process.exit(0));

// Self-warm: load the model now so the first real query doesn't pay for the load.
void embedText('warm').finally(() => process.send?.({ ready: true }));
