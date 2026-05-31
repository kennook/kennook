// Cooperative stop for long-running enrichment scripts. The admin job
// runner sends SIGTERM when the user pauses the queue. By installing a
// handler we OVERRIDE Node's default "die immediately on SIGTERM" — the
// process keeps running until the item loop next checks shouldStop(),
// then breaks cleanly after the current item's DB write.
//
// The runner escalates to SIGKILL after a grace period, so a script that
// forgets to check shouldStop() still gets stopped — its in-flight item
// simply reruns on resume (per-item status flags make that safe).
//
// Usage:
//   installGracefulStop();                 // once, at script start
//   for (const row of pending) {
//     if (shouldStop()) break;             // top of the loop
//     ...process row...
//   }

let stopRequested = false;
let installed = false;

export function installGracefulStop(): void {
  if (installed) return;
  installed = true;
  const onSignal = () => { stopRequested = true; };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

export function shouldStop(): boolean {
  return stopRequested;
}
