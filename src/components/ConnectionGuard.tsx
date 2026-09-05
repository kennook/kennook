'use client';

import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConnection, useSync } from '@/lib/sync';
import { KENNOOK_BUILD_ID } from '@/lib/version';

/**
 * A single, consistent "the server is unreachable" experience.
 *
 * When the main server restarts (an upgrade) every connected window would
 * otherwise degrade differently — a broken Chrome error page here, a video
 * "Retry" panel there, assorted tRPC errors elsewhere. ConnectionGuard replaces
 * all of that with ONE calm full-screen overlay that self-heals: the sync
 * broker's heartbeat (`useConnection`) flips to `unreachable`, the overlay takes
 * over, and it keeps probing (fast, then backing off) until the server answers.
 *
 * On recovery it does the minimum needed:
 *   • the server came back on a DIFFERENT build  → the loaded bundle is stale
 *     (its lazy chunks would 404), so hard-reload to the fresh build.
 *   • the server came back on the SAME build      → just dismiss and refetch
 *     active queries; in-page state (scroll, open viewer) is kept.
 *
 * Mounted once in the provider tree, so it covers desktop, mobile, /admin and
 * /login alike. `AppErrorBoundary` (below) sits under it so a render crash
 * during the outage — classically a ChunkLoadError — can't escape to Chrome's
 * default error page; the overlay stays on top of the boundary's fallback.
 */

// ── The reconnect overlay ────────────────────────────────────────────────────

function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ConnectionGuard() {
  const { status, serverBuild } = useConnection();
  const sync = useSync();
  const queryClient = useQueryClient();

  const prevStatus = useRef(status);
  const reloadingRef = useRef(false);
  const [downSince, setDownSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Brief "back online" beat shown while a stale-build reload is in flight, so
  // the transition doesn't look like a hang before the page swaps.
  const [refreshing, setRefreshing] = useState(false);

  // React to status transitions.
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (status === 'unreachable' && prev !== 'unreachable') {
      setDownSince(Date.now());
      return;
    }

    if (status === 'ok' && prev === 'unreachable') {
      setDownSince(null);
      const staleBuild = serverBuild != null && serverBuild !== KENNOOK_BUILD_ID;
      if (staleBuild) {
        // New build is live — our chunks are stale. Reload to recover cleanly.
        if (!reloadingRef.current) {
          reloadingRef.current = true;
          setRefreshing(true);
          // Let the "refreshing" frame paint, then swap.
          setTimeout(() => window.location.reload(), 350);
        }
      } else {
        // Same build, just a restart — resume in place and pull everything
        // current (clears queries that errored out during the outage).
        void queryClient.invalidateQueries();
      }
    }
  }, [status, serverBuild, queryClient]);

  // Tick the "disconnected for m:ss" readout only while the overlay is up.
  useEffect(() => {
    if (downSince == null) { setElapsed(0); return; }
    setElapsed(Date.now() - downSince);
    const id = setInterval(() => setElapsed(Date.now() - downSince), 1000);
    return () => clearInterval(id);
  }, [downSince]);

  if (status === 'ok' && !refreshing) return null;

  const backOnline = refreshing;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center
                 bg-neutral-950/95 backdrop-blur-sm px-6 text-center
                 text-neutral-200 select-none"
      role="alertdialog"
      aria-live="assertive"
      aria-label={backOnline ? 'Reconnected' : 'Connection lost'}
    >
      <div className="flex max-w-sm flex-col items-center gap-5">
        {backOnline ? (
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
            <path d="M4 12.5l5 5 11-11" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
               className="animate-spin text-neutral-400" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        )}

        {backOnline ? (
          <>
            <h1 className="text-lg font-semibold text-neutral-100">Back online</h1>
            <p className="text-sm text-neutral-400">Refreshing to the latest version…</p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-neutral-100">Reconnecting…</h1>
            <p className="text-sm leading-relaxed text-neutral-400">
              KenNook can’t reach your library right now. This usually means the
              server is restarting — it’ll pick back up automatically.
            </p>
            <div className="flex flex-col items-center gap-3">
              <span className="text-xs tabular-nums text-neutral-500">
                Disconnected for {fmtElapsed(elapsed)} · retrying…
              </span>
              <button
                onClick={() => sync.checkNow()}
                className="rounded-md bg-neutral-800 px-4 py-1.5 text-sm font-medium
                           text-neutral-200 ring-1 ring-neutral-700 transition
                           hover:bg-neutral-700"
              >
                Try now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── App-wide error boundary ──────────────────────────────────────────────────

const CHUNK_ERROR = /ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed/i;

interface BoundaryProps {
  children: ReactNode;
  /** True while the server is reachable. A false→true flip lets the boundary
   *  retry its children (the outage that crashed them has cleared). */
  connOk: boolean;
}
interface BoundaryState {
  error: Error | null;
}

/**
 * Catches render crashes so they don't fall through to Next.js's default error
 * page (the "broken Chrome window"). The commonest one during an upgrade is a
 * ChunkLoadError — a lazy chunk fetched from a server that's mid-restart or now
 * on a new build. We don't blind-reload (that loops while the server is down);
 * instead we show a consistent card, and recovery reloads via ConnectionGuard.
 */
class ErrorBoundaryInner extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[ConnectionGuard] render error caught by boundary:', error);
  }

  componentDidUpdate(prev: BoundaryProps): void {
    // Server came back (and children aren't obviously still broken from a stale
    // bundle) — clear the error so children re-render instead of staying stuck.
    if (this.state.error && !prev.connOk && this.props.connOk
        && !CHUNK_ERROR.test(this.state.error.message)) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isChunk = CHUNK_ERROR.test(error.message);
    return (
      <div
        className="fixed inset-0 z-[150] flex items-center justify-center
                   bg-neutral-950/95 px-6 text-center text-neutral-200"
        role="alertdialog"
      >
        <div className="flex max-w-sm flex-col items-center gap-5">
          <h1 className="text-lg font-semibold text-neutral-100">
            {isChunk ? 'A refresh is needed' : 'Something went wrong'}
          </h1>
          <p className="text-sm leading-relaxed text-neutral-400">
            {isChunk
              ? 'This window is running an older version of KenNook. Reload to pick up the latest.'
              : 'This window hit an unexpected error. Reloading usually clears it.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-neutral-100 px-4 py-1.5 text-sm font-medium
                       text-neutral-900 transition hover:bg-white"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { status } = useConnection();
  return <ErrorBoundaryInner connOk={status === 'ok'}>{children}</ErrorBoundaryInner>;
}
