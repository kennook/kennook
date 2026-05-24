'use client';

import { useCallback, useEffect, useId, useState } from 'react';

/**
 * Single-audio-source coordinator. Two responsibilities:
 *
 *   1. At most one VideoPlayer holds the "audio leader" token at a time,
 *      across every tab in the same browser. Cross-tab fanout is via
 *      `BroadcastChannel` — instant, no server hop. When one player
 *      claims (the user unmutes it), every other player force-mutes
 *      until it releases.
 *
 *   2. A `suppressed` flag overrides everything else: while it's true,
 *      no player produces sound regardless of leader / preference.
 *      Currently flipped by the Screensaver on open/close.
 *
 * The "cross-device" variant (mute videos on the laptop when I unmute
 * one on the phone) isn't wired here — it'd need an SSE event class
 * and the perf gain over "user pauses one device first" felt
 * marginal. Easy to add later if you want it.
 */

interface AudioState {
  /** id of the player that currently owns audio, or null if nobody. */
  leaderId: string | null;
  /** All audio is force-muted (e.g., screensaver showing). */
  suppressed: boolean;
}
type Listener = (state: AudioState) => void;

class AudioLeader {
  private state: AudioState = { leaderId: null, suppressed: false };
  private listeners = new Set<Listener>();
  private bc: BroadcastChannel | null = null;
  private started = false;

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.bc = new BroadcastChannel('kennook.audio.v1');
    this.bc.onmessage = (e) => {
      const data = e.data as { type?: string; id?: string } | null;
      if (!data) return;
      if (data.type === 'claim' && data.id) {
        this.state = { ...this.state, leaderId: data.id };
        this.emit();
      } else if (data.type === 'release' && data.id) {
        if (this.state.leaderId === data.id) {
          this.state = { ...this.state, leaderId: null };
          this.emit();
        }
      }
    };
  }

  claim(id: string): void {
    if (this.state.suppressed) return;
    this.state = { ...this.state, leaderId: id };
    this.bc?.postMessage({ type: 'claim', id });
    this.emit();
  }

  release(id: string): void {
    if (this.state.leaderId !== id) return;
    this.state = { ...this.state, leaderId: null };
    this.bc?.postMessage({ type: 'release', id });
    this.emit();
  }

  setSuppressed(suppressed: boolean): void {
    if (this.state.suppressed === suppressed) return;
    // Clearing leadership when suppression turns on means that when the
    // screensaver closes, no random video starts blasting — the user has
    // to deliberately unmute again.
    this.state = {
      leaderId: suppressed ? null : this.state.leaderId,
      suppressed,
    };
    this.emit();
  }

  get current(): AudioState {
    return this.state;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => { this.listeners.delete(cb); };
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.state);
  }
}

export const audioLeader = new AudioLeader();
if (typeof window !== 'undefined') audioLeader.start();

/**
 * Hook for a VideoPlayer (or anything else that produces audio). Returns:
 *   - `isLeader`     — this instance currently owns audio
 *   - `leaderActive` — *some* instance owns audio (could be elsewhere)
 *   - `suppressed`   — screensaver / equivalent has muted everyone
 *   - `claim` / `release` — call when the user explicitly (un)mutes
 *
 * Auto-releases on unmount so closing the viewer doesn't leave a stale
 * leader id pinned across tabs.
 */
export function useAudioLeader() {
  // useId is stable per component-instance lifecycle, unique across the
  // app, and is safe inside the same tab. For cross-tab uniqueness we
  // prefix it with a per-tab session segment via crypto.randomUUID().
  const reactId = useId();
  const [tabPrefix] = useState(() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().slice(0, 8);
    }
    return Math.random().toString(36).slice(2, 10);
  });
  const id = `${tabPrefix}:${reactId}`;

  const [state, setState] = useState<AudioState>(audioLeader.current);
  useEffect(() => audioLeader.subscribe(setState), []);

  const claim = useCallback(() => audioLeader.claim(id), [id]);
  const release = useCallback(() => audioLeader.release(id), [id]);

  // Cleanup on unmount — also drops leadership if held.
  useEffect(() => () => { audioLeader.release(id); }, [id]);

  return {
    isLeader: state.leaderId === id,
    leaderActive: state.leaderId !== null,
    suppressed: state.suppressed,
    claim,
    release,
  };
}
