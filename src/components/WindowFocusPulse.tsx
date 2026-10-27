'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Flashes a pulsing ring around the viewport whenever this browser window gains
 * focus — but only when at least one OTHER KenNook window is open. With several
 * windows, cycling focus (cmd+`) gives no cue about which one landed on top;
 * this is that cue. With a single window there's nothing to disambiguate, so it
 * stays quiet.
 *
 * Listens for the window `focus` event (fired on gaining focus, not on clicks
 * within an already-focused window). Each qualifying focus bumps a counter that
 * keys the overlay so the CSS animation replays from the start even mid-pulse;
 * the overlay unmounts when the animation ends. Desktop-only — mounted from the
 * desktop branch of the page root, since mobile has no multi-window concept.
 */
export function WindowFocusPulse() {
  const [pulse, setPulse] = useState(0);
  const hasPeers = usePeerWindows();
  const hasPeersRef = useRef(hasPeers);
  hasPeersRef.current = hasPeers;

  useEffect(() => {
    const onFocus = () => {
      if (hasPeersRef.current) setPulse((n) => n + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!pulse) return null;

  return (
    <div
      key={pulse}
      aria-hidden
      onAnimationEnd={() => setPulse(0)}
      className="kn-focus-pulse pointer-events-none fixed inset-0 z-[100]"
    />
  );
}

// Presence heartbeat timings. Each window pings on this interval; a peer is
// considered gone if we haven't heard from it within the TTL (a few missed
// pings). Self-healing: a window that missed earlier messages (e.g. it was in
// the background when the others opened) rediscovers everyone within one ping.
const PING_MS = 2000;
const PEER_TTL_MS = 6500; // > 3 pings of slack

/**
 * True when one or more other same-origin KenNook windows/tabs are open, via a
 * BroadcastChannel presence HEARTBEAT: every window pings periodically and tracks
 * when it last heard from each peer, expiring stale ones. This replaced a
 * one-shot hello/here handshake that could leave a window permanently thinking
 * it was alone if it missed the initial messages — which is why the focus pulse
 * never fired on an occasional window. Best-effort and cosmetic.
 */
function usePeerWindows(): boolean {
  const [hasPeers, setHasPeers] = useState(false);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel('kennook-windows');
    const myId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    const peers = new Map<string, number>(); // id → last-seen (ms)
    const sync = () => setHasPeers(peers.size > 0);

    const prune = () => {
      const now = Date.now();
      let changed = false;
      for (const [id, seen] of peers) {
        if (now - seen > PEER_TTL_MS) { peers.delete(id); changed = true; }
      }
      if (changed) sync();
    };

    channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; id?: string } | null;
      if (!msg?.id || msg.id === myId) return;
      if (msg.type === 'ping') {
        const known = peers.has(msg.id);
        peers.set(msg.id, Date.now());
        if (!known) {
          // New peer — ping straight back so IT learns about us without waiting
          // for our next interval tick.
          channel.postMessage({ type: 'ping', id: myId });
          sync();
        }
      } else if (msg.type === 'bye') {
        if (peers.delete(msg.id)) sync();
      }
    };

    const ping = () => channel.postMessage({ type: 'ping', id: myId });
    ping(); // announce immediately
    const iv = window.setInterval(() => { ping(); prune(); }, PING_MS);

    // Re-announce the moment we regain focus/visibility so a just-foregrounded
    // window refreshes presence promptly (and its pulse reflects reality).
    const reannounce = () => ping();
    window.addEventListener('focus', reannounce);
    document.addEventListener('visibilitychange', reannounce);

    const sayBye = () => channel.postMessage({ type: 'bye', id: myId });
    window.addEventListener('pagehide', sayBye);

    return () => {
      window.clearInterval(iv);
      sayBye();
      window.removeEventListener('focus', reannounce);
      document.removeEventListener('visibilitychange', reannounce);
      window.removeEventListener('pagehide', sayBye);
      channel.close();
    };
  }, []);

  return hasPeers;
}
