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

/**
 * True when one or more other same-origin KenNook windows/tabs are open, via a
 * BroadcastChannel presence handshake: on mount we announce ourselves and every
 * peer replies; each window says goodbye on unload. Best-effort and cosmetic —
 * a missed goodbye (e.g. a crash) just means a stale peer until it re-syncs.
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
    const peers = new Set<string>();
    const sync = () => setHasPeers(peers.size > 0);

    channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; id?: string } | null;
      if (!msg?.id || msg.id === myId) return;
      if (msg.type === 'hello') {
        // A new window arrived — record it and announce ourselves back.
        peers.add(msg.id);
        channel.postMessage({ type: 'here', id: myId });
        sync();
      } else if (msg.type === 'here') {
        peers.add(msg.id);
        sync();
      } else if (msg.type === 'bye') {
        peers.delete(msg.id);
        sync();
      }
    };

    channel.postMessage({ type: 'hello', id: myId });

    const sayBye = () => channel.postMessage({ type: 'bye', id: myId });
    window.addEventListener('pagehide', sayBye);

    return () => {
      sayBye();
      window.removeEventListener('pagehide', sayBye);
      channel.close();
    };
  }, []);

  return hasPeers;
}
