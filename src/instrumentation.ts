/**
 * Next.js startup hook (runs once when the server boots, in BOTH dev and prod).
 *
 * CRITICAL: Next.js AWAITS `register()` before the server starts serving
 * requests — so this function must return fast and NEVER block on slow work.
 * mDNS discovery and (especially) loading the heavy AI stack
 * (onnxruntime + transformers) to warm the embed worker take real time on a
 * modest box; awaiting them here made the very first page load hang for minutes.
 * We now kick both off in the BACKGROUND so the server serves immediately; the
 * warm-up finishes on its own (only the first search waits for it, once).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // mDNS advertise + the "connect a device" banner. Fire-and-forget.
  void import('@/server/discovery')
    .then(({ startDiscovery }) => startDiscovery())
    .catch((err) => console.error('[startup] discovery failed:', err));

  // Pre-spawn + warm the search embed worker (loads the CLIP model). This import
  // alone drags in onnxruntime/transformers, so keep it OFF the startup path.
  void import('@/ai/embed-client')
    .then(({ warmEmbedWorker }) => warmEmbedWorker())
    .catch((err) => console.error('[startup] embed warm failed:', err));
}
