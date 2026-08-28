'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';

/**
 * Multi-session sync events. Transport:
 *
 *   1. `BroadcastChannel` — same-browser tabs, instant, no server round-trip.
 *      Carries both client-published events and the leader's relayed
 *      cross-device traffic (below).
 *   2. SSE (`/api/sync`) — cross-device. A long-lived SSE stream permanently
 *      occupies one of the browser's ~6 HTTP/1.1 connections per host, so a
 *      stream PER TAB exhausts the pool once several windows are open (the
 *      original bug: the app stalls because nothing's left for tRPC / images /
 *      video). Instead, exactly ONE tab per browser — elected via the Web
 *      Locks API — holds the stream and RELAYS what it receives to the other
 *      tabs over the BroadcastChannel. Many windows → one connection. Browsers
 *      without Web Locks fall back to one stream per tab (the old behavior).
 *
 * Each tab generates a `SESSION_ID` on load; envelopes carry it so the
 * originating tab can skip its own event when it loops back (the server echoes
 * to every stream, and the leader re-broadcasts it locally).
 */

export type SyncEvent =
  | { type: 'screensaver'; open: boolean }
  /** Per-tab integer issued by the server on SSE connect. The client uses
   *  it (modulo the manifest size) to pick which screensaver video to
   *  show, so each open window in a session draws a different one. */
  | { type: 'screensaver.assignment'; index: number }
  | { type: 'item.like'; librarySlug: string; uuid: string; count: number }
  | { type: 'item.tag.changed'; librarySlug: string; uuid: string }
  /** A video bookmark was added/removed/edited; open viewers refresh the list. */
  | { type: 'item.bookmark.changed'; librarySlug: string; uuid: string }
  /** A video's autoplay trim (start/stop) changed; open viewers refresh it. */
  | { type: 'item.trim.changed'; librarySlug: string; uuid: string }
  /** This user's per-video "climax" marker changed; their open viewers of that
   *  item refresh it (per-user, so routed via publishToUser). */
  | { type: 'item.climax.changed'; librarySlug: string; uuid: string }
  /** Broadcast "jump to climax": every open viewer seeks ITS OWN video to that
   *  user's climax for it (and resumes play). No payload — each viewer reads its
   *  own item's climax. The initiator skips its own echo, so it seeks locally. */
  | { type: 'climax.jump' }
  | { type: 'item.rotation'; librarySlug: string; uuid: string; rotation: number }
  /** Manual sensitivity override changed (1 sensitive / 0 safe / null auto). */
  | { type: 'item.sensitive'; librarySlug: string; uuid: string; override: number | null }
  /** An item was soft-deleted ("excluded"); other tabs drop it from grids and
   *  close it if it's the one they have open. */
  | { type: 'item.excluded'; librarySlug: string; uuid: string }
  /** N items were moved out of `librarySlug` into `targetLibrarySlug`; other
   *  tabs drop them from the source grid (re-indexing in the target is async). */
  | { type: 'items.moved'; librarySlug: string; targetLibrarySlug: string; count: number }
  | { type: 'playlist.changed' }
  /** A saved search was created or deleted; other tabs refresh the list. */
  | { type: 'savedSearch.changed' }
  /** A per-user sidebar list changed (playlists / saved searches / external
   *  sources). The cross-process poll emits this so other DEVICES refetch. */
  | { type: 'data.changed' }
  /** An asset's saved pan/zoom framing changed (per orientation). Other open
   *  clients invalidate that key so their NEXT open is fresh. */
  | { type: 'mediaView.changed'; librarySlug: string; uuid: string; orientation: 'portrait' | 'landscape' }
  /** An admin changed instance configuration; clients refetch the config. */
  | { type: 'config.changed' }
  /** Solo-audio rule: a window broadcasts this when the user unmutes it, and
   *  every OTHER window/device mutes itself in response. Muting broadcasts
   *  nothing (everyone just stays muted). No payload — the sender is identified
   *  by the envelope's sessionId, which it skips on echo. */
  | { type: 'audio.unmuted' }
  /** Build version of the server process this stream is connected to. Sent
   *  in the on-connect snapshot and again on every EventSource reconnect, so
   *  when the prod process restarts onto a new build the client sees the new
   *  version and can prompt a reload. `buildId` changes on every build even
   *  when the semver is unchanged (rebuild/hotfix). */
  | { type: 'server-version'; version: string; buildId: string };

interface Envelope {
  sessionId: string;
  event: SyncEvent;
}

const BC_NAME = 'kennook.sync.v1';
// Cross-tab leader election over localStorage. Web Locks would be cleaner but
// it's secure-context-only (undefined on `http://<lan-ip>` — exactly where the
// multi-screen use lives), so we lease a localStorage key instead: works on
// plain HTTP, shared across same-origin windows, and broadcasts via `storage`
// events. The leader owns the single SSE + poll and relays to the others.
const LEADER_KEY = 'kennook.sync.leader.v1';
// Leader rewrites its lease this often; a lease older than STALE is up for grabs
// (≈2-3 missed heartbeats → a closed/crashed leader is replaced within seconds).
const LEADER_HEARTBEAT_MS = 1500;
const LEADER_STALE_MS = 4000;

interface LeaderLease { id: string; ts: number }

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
  // True only for the elected leader — the tab that owns the SSE + poll and
  // relays what it receives to sibling tabs over the BroadcastChannel.
  private amLeader = false;
  private electionTimer: ReturnType<typeof setInterval> | null = null;
  private onPageHide: (() => void) | null = null;
  // Cross-process screensaver poll (see `startStatePoll`). Runs alongside the
  // SSE — so once per browser under leader election — instead of per tab.
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // Last time a screensaver toggle flowed through (published or received). The
  // poll trusts this recent intent and won't clobber a just-made change.
  private lastScreensaverAt = 0;
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

    this.startElection();
  }

  // ── Leader election (localStorage lease) ──────────────────────────────────

  private readLease(): LeaderLease | null {
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      return raw ? (JSON.parse(raw) as LeaderLease) : null;
    } catch { return null; }
  }

  private writeLease(): void {
    try { localStorage.setItem(LEADER_KEY, JSON.stringify({ id: SESSION_ID, ts: Date.now() })); }
    catch { /* storage unavailable — we simply won't be electable */ }
  }

  private startElection(): void {
    // No localStorage (rare / sandboxed): can't coordinate, so act standalone —
    // one stream per tab, the pre-election behavior.
    if (typeof localStorage === 'undefined') { this.becomeLeader(); return; }

    this.onPageHide = () => {
      // Release the lease on a graceful close so a follower takes over at once
      // instead of waiting out the stale window.
      if (this.amLeader) { try { localStorage.removeItem(LEADER_KEY); } catch { /* noop */ } }
    };
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('storage', this.onStorage);

    this.electionTimer = setInterval(() => this.electionTick(), LEADER_HEARTBEAT_MS);
    this.electionTick(); // elect immediately on load
  }

  private electionTick(): void {
    const lease = this.readLease();
    const stale = !lease || Date.now() - lease.ts > LEADER_STALE_MS;
    if (this.amLeader) {
      // Someone else holds a fresh lease → concede (shouldn't normally happen).
      if (lease && lease.id !== SESSION_ID && !stale) this.stepDown();
      else this.writeLease(); // heartbeat
    } else if (stale) {
      this.tryClaim();
    }
  }

  private tryClaim(): void {
    this.writeLease();
    // Re-check after a jittered beat: with simultaneous claims the last writer
    // wins the key, and only that tab sees its own id here — so exactly one
    // promotes. (A rare overlap is resolved by the next heartbeat/storage tick.)
    setTimeout(() => {
      if (!this.started || this.amLeader) return;
      const lease = this.readLease();
      if (lease && lease.id === SESSION_ID) this.becomeLeader();
    }, 80 + Math.floor(Math.random() * 160));
  }

  private onStorage = (e: StorageEvent): void => {
    if (e.key !== LEADER_KEY) return;
    const lease = this.readLease();
    const stale = !lease || Date.now() - lease.ts > LEADER_STALE_MS;
    if (this.amLeader) {
      if (lease && lease.id !== SESSION_ID && !stale) this.stepDown();
    } else if (stale) {
      this.tryClaim(); // leader vanished (lease cleared/expired) — race to fill
    }
  };

  private becomeLeader(): void {
    if (this.amLeader) return;
    this.amLeader = true;
    this.writeLease();
    this.openEventSource();
  }

  private stepDown(): void {
    if (!this.amLeader) return;
    this.amLeader = false;
    this.es?.close(); this.es = null;
    this.stopStatePoll();
  }

  private openEventSource(): void {
    this.es = new EventSource('/api/sync');
    this.es.onmessage = (e) => {
      let env: Envelope;
      try { env = JSON.parse(e.data) as Envelope; } catch { return; /* malformed frame */ }
      // As the leader, fan cross-device events out to sibling tabs. Skip
      // `screensaver.assignment` — it's per-connection, so each window keeps
      // its own index (a shared one would make every window play the same
      // clip). BroadcastChannel never echoes to the sender, so this can't loop.
      if (this.amLeader && env.event.type !== 'screensaver.assignment') {
        this.bc?.postMessage(env);
      }
      this.deliver(env);
    };
    // EventSource auto-reconnects on `error` after a backoff; nothing to do.

    // The cross-process screensaver poll accompanies the SSE, so it runs once
    // per browser (the leader) — never per tab.
    this.startStatePoll();
  }

  /**
   * Cross-process convergence. Caddy fronts a prod build (:3001) AND the dev
   * server (:3000); devices on different origins hit different Node processes
   * whose in-memory SSE brokers don't talk. They DO share one user.db, so the
   * SSE owner polls the persisted screensaver state and, on a change, converges
   * this browser — local handlers + sibling tabs (NOT the server: the state we
   * just read already reflects every process's writes). A short guard window
   * keeps a stale poll from clobbering a just-made toggle.
   */
  private startStatePoll(): void {
    if (this.pollTimer != null) return;
    const POLL_MS = 2000;
    const poll = async () => {
      try {
        const res = await fetch('/api/sync/state', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { screensaver?: boolean; audio?: string | null; rev?: string | null };
        this.handleScreensaverPoll(data.screensaver);
        this.handleAudioPoll(data.audio);
        this.handleDataRevPoll(data.rev);
      } catch { /* offline / transient — retry next tick */ }
    };
    this.pollTimer = setInterval(poll, POLL_MS);
    void poll();
  }

  private lastPolledScreensaver: boolean | null = null;
  private handleScreensaverPoll(open: boolean | undefined): void {
    if (typeof open !== 'boolean') return;
    const GUARD_MS = 3000;
    // Within the guard window, trust the just-made local toggle: track the
    // observed state but don't emit (so a stale poll can't clobber it).
    if (Date.now() - this.lastScreensaverAt < GUARD_MS) {
      this.lastPolledScreensaver = open;
      return;
    }
    if (open === this.lastPolledScreensaver) return; // no change since last look
    this.lastPolledScreensaver = open;
    const event: SyncEvent = { type: 'screensaver', open };
    this.emitLocal(event);                                  // this (leader) tab
    this.bc?.postMessage({ sessionId: SESSION_ID, event }); // sibling tabs
  }

  // Solo-audio marker "<ms>:<sessionId>". `undefined` = not yet polled, so the
  // marker already present at page load doesn't fire a spurious mute (videos
  // start muted anyway). On a NEW marker owned by another session, mute here.
  private lastPolledAudio: string | null | undefined = undefined;
  private handleAudioPoll(token: string | null | undefined): void {
    if (token == null) { this.lastPolledAudio = token ?? null; return; }
    if (token === this.lastPolledAudio) return;
    const first = this.lastPolledAudio === undefined;
    this.lastPolledAudio = token;
    if (first) return; // don't act on the marker that existed at load
    const ownerSession = token.split(':')[1] ?? '';
    if (!ownerSession || ownerSession === SESSION_ID) return; // our own unmute
    const event: SyncEvent = { type: 'audio.unmuted' };
    this.emitLocal(event); // this (leader) tab mutes
    // Tag the relay with the OWNER's session so a same-browser owner tab skips
    // it (stays unmuted) while every other tab mutes.
    this.bc?.postMessage({ sessionId: ownerSession, event });
  }

  // Sidebar data revision. `undefined` = not yet polled (don't refetch on the
  // first observation). On a change, emit `data.changed` so this device
  // refetches its sidebar lists — this is what makes playlists / saved searches
  // / external sources appear on OTHER devices without a reload.
  private lastPolledRev: string | null | undefined = undefined;
  private handleDataRevPoll(rev: string | null | undefined): void {
    if (rev == null) { this.lastPolledRev = rev ?? null; return; }
    if (rev === this.lastPolledRev) return;
    const first = this.lastPolledRev === undefined;
    this.lastPolledRev = rev;
    if (first) return;
    const event: SyncEvent = { type: 'data.changed' };
    this.emitLocal(event);
    this.bc?.postMessage({ sessionId: SESSION_ID, event });
  }

  private stopStatePoll(): void {
    if (this.pollTimer != null) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.lastPolledScreensaver = null;
    this.lastPolledRev = undefined;
    this.lastPolledAudio = undefined;
  }

  /** Run handlers for a locally-sourced event (the poll) — no sessionId skip. */
  private emitLocal(event: SyncEvent): void {
    for (const h of this.handlers) h(event);
  }

  stop(): void {
    this.stopStatePoll();
    if (this.electionTimer != null) { clearInterval(this.electionTimer); this.electionTimer = null; }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.onStorage);
      if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
    }
    this.onPageHide = null;
    // Hand off leadership immediately so a sibling tab promotes without waiting
    // out the stale window.
    if (this.amLeader) { try { localStorage.removeItem(LEADER_KEY); } catch { /* noop */ } }
    this.amLeader = false;
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
    if (event.type === 'screensaver') this.lastScreensaverAt = Date.now();
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
    if (env.event.type === 'screensaver') this.lastScreensaverAt = Date.now();
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
