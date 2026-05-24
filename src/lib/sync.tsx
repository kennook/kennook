'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';

/**
 * Multi-session sync events. Two-layer transport:
 *
 *   1. `BroadcastChannel` for tabs in the same browser — instant, free,
 *      no server round-trip.
 *   2. SSE (`/api/sync`) for cross-device — one HTTP stream per tab,
 *      auto-reconnecting via the `EventSource` API.
 *
 * Each tab generates a `SESSION_ID` on load; envelopes carry it so the
 * originating tab can skip its own event when it loops back through SSE
 * (the server publishes to every active stream, including the sender).
 */

export type SyncEvent =
  | { type: 'screensaver'; open: boolean }
  /** Per-tab integer issued by the server on SSE connect. The client uses
   *  it (modulo the manifest size) to pick which screensaver video to
   *  show, so each open window in a session draws a different one. */
  | { type: 'screensaver.assignment'; index: number }
  | { type: 'item.like'; workspaceSlug: string; uuid: string; count: number }
  | { type: 'item.tag.changed'; workspaceSlug: string; uuid: string }
  | { type: 'item.rotation'; workspaceSlug: string; uuid: string; rotation: number }
  | { type: 'playlist.changed' };

interface Envelope {
  sessionId: string;
  event: SyncEvent;
}

const BC_NAME = 'kennook.sync.v1';

function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Stable per-tab identifier. Exported for the tRPC client so server-
 *  initiated events (likes, tags, playlists) carry the originating tab's
 *  id and can be skipped on echo. */
export const SESSION_ID = makeSessionId();

type Handler = (e: SyncEvent) => void;

class SyncBroker {
  private bc: BroadcastChannel | null = null;
  private es: EventSource | null = null;
  private handlers = new Set<Handler>();
  private started = false;
  // Latest server-issued screensaver index for this tab. Initialized to a
  // random value so even offline / first-render-before-SSE-connects the
  // tab picks something; the server's authoritative value overrides on
  // arrival. Surface via `getScreensaverIndex()` so components that mount
  // AFTER the assignment frame still see the right value.
  private screensaverIndex: number = Math.floor(Math.random() * 1024);

  getScreensaverIndex(): number {
    return this.screensaverIndex;
  }

  start(): void {
    if (typeof window === 'undefined' || this.started) return;
    this.started = true;

    this.bc = new BroadcastChannel(BC_NAME);
    this.bc.onmessage = (e) => this.deliver(e.data as Envelope);

    this.es = new EventSource('/api/sync');
    this.es.onmessage = (e) => {
      try {
        const env = JSON.parse(e.data) as Envelope;
        this.deliver(env);
      } catch { /* malformed frame — skip */ }
    };
    // EventSource auto-reconnects on `error` after a backoff; nothing to do.
  }

  stop(): void {
    this.bc?.close(); this.bc = null;
    this.es?.close(); this.es = null;
    this.started = false;
  }

  subscribe(h: Handler): () => void {
    this.handlers.add(h);
    return () => { this.handlers.delete(h); };
  }

  /** Publish a client-originated event. Goes both to same-browser tabs
   *  (instant) and to other devices (via the SSE publish endpoint). */
  publish(event: SyncEvent): void {
    const env: Envelope = { sessionId: SESSION_ID, event };
    this.bc?.postMessage(env);
    void fetch('/api/sync/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
      keepalive: true,
    }).catch(() => { /* offline — local tabs still got it via BC */ });
  }

  private deliver(env: Envelope): void {
    if (env.sessionId === SESSION_ID) return; // skip echoes from this tab
    if (env.event.type === 'screensaver.assignment') {
      this.screensaverIndex = env.event.index;
    }
    for (const h of this.handlers) h(env.event);
  }
}

const broker = new SyncBroker();

const SyncContext = createContext<SyncBroker>(broker);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    broker.start();
    return () => broker.stop();
  }, []);
  return <SyncContext.Provider value={broker}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncBroker {
  return useContext(SyncContext);
}

/**
 * Reactive per-tab screensaver index. Returns the broker's current value
 * (which may be the random fallback before the server's assignment
 * arrives) and updates whenever a fresh assignment is delivered.
 */
export function useScreensaverIndex(): number {
  const sync = useSync();
  const [index, setIndex] = useState(() => sync.getScreensaverIndex());
  useSyncEvent('screensaver.assignment', (e) => setIndex(e.index));
  return index;
}

/**
 * Subscribe to one event type. The handler is captured in a ref so
 * callers don't have to memoize it — the effect itself only re-attaches
 * on type changes.
 */
export function useSyncEvent<T extends SyncEvent['type']>(
  type: T,
  handler: (e: Extract<SyncEvent, { type: T }>) => void,
): void {
  const sync = useSync();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    return sync.subscribe((e) => {
      if (e.type === type) ref.current(e as Extract<SyncEvent, { type: T }>);
    });
  }, [type, sync]);
}
