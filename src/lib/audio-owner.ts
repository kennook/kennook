'use client';

/**
 * Per-window "audio owner" persistence — the memory behind restoring a video
 * viewer's unmuted state across a reload.
 *
 * Only one window/device plays sound at a time (the solo-audio rule: unmuting
 * broadcasts `audio.unmuted`, muting every other player). That single unmuted
 * window is the "audio owner". We remember whether THIS window is the owner in
 * `sessionStorage`, which:
 *   - survives a reload of this window (so the owner comes back unmuted), and
 *   - is isolated per tab/window (so muted windows — and other tabs, with their
 *     own sessionStorage — stay muted; no two windows both try to grab audio).
 *
 * Autoplay policy is the catch: a freshly-loaded document has no user
 * activation, so the browser may refuse unmuted playback. `restoreAudioOwner`
 * handles that — it unmutes optimistically (works when the browser's media
 * engagement grants sound) and, if the browser pushes back by pausing the
 * element, falls back to muted-but-playing and unmutes on the first user
 * gesture (which is always permitted).
 */

const AUDIO_OWNER_KEY = 'kennook.audioOwner';

/** True if THIS window was the unmuted audio owner (persisted across reload). */
export function readAudioOwner(): boolean {
  try {
    return sessionStorage.getItem(AUDIO_OWNER_KEY) === '1';
  } catch {
    return false; // private mode / sandboxed
  }
}

/** Record whether THIS window currently owns audio (is unmuted). */
export function writeAudioOwner(owner: boolean): void {
  try {
    sessionStorage.setItem(AUDIO_OWNER_KEY, owner ? '1' : '0');
  } catch {
    /* noop */
  }
}

interface RestoreHandlers {
  /** Unmute the element + React state, solo audio, and persist ownership. */
  onUnmute: () => void;
  /** Mute the element + React state, and clear ownership. */
  onMute: () => void;
  /** Optional: called once if the optimistic unmute sticks (for a HUD flash). */
  onRestored?: () => void;
}

/**
 * If this window was the audio owner, restore its unmuted state on the given
 * media element once it's playing — with the autoplay-policy fallback described
 * above. No-op (returns a noop cleanup) when this window wasn't the owner.
 *
 * Returns a cleanup function; call it on unmount to cancel pending timers and
 * listeners.
 */
export function restoreAudioOwner(
  video: HTMLMediaElement,
  handlers: RestoreHandlers,
): () => void {
  if (!readAudioOwner()) return () => {};

  let settleTimer = 0;
  let gestureArmed = false;

  const armGestureUnmute = () => {
    if (gestureArmed) return;
    gestureArmed = true;
    const onGesture = () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      handlers.onUnmute();
      void video.play().catch(() => {});
    };
    // Capture-phase + once: fire on the very first interaction anywhere.
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  };

  const attempt = () => {
    // Optimistic unmute — the handlers unmute the element, solo, and persist.
    handlers.onUnmute();
    // Give the autoplay policy a beat to react. If it refused (it pauses the
    // element to enforce "no unmuted playback without a gesture"), fall back to
    // muted playback and wait for the first user gesture to unmute for real.
    settleTimer = window.setTimeout(() => {
      if (video.paused) {
        handlers.onMute();
        void video.play().catch(() => {});
        armGestureUnmute();
      } else {
        handlers.onRestored?.();
      }
    }, 200);
  };

  // Only unmute once it's actually playing — checking `paused` before playback
  // has begun would misread "not started yet" as "policy refused".
  let cleanupPlaying = () => {};
  if (!video.paused && video.currentTime > 0) {
    attempt();
  } else {
    const onPlaying = () => attempt();
    video.addEventListener('playing', onPlaying, { once: true });
    cleanupPlaying = () => video.removeEventListener('playing', onPlaying);
  }

  return () => {
    window.clearTimeout(settleTimer);
    cleanupPlaying();
  };
}
