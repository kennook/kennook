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
 * probes for permission the sanctioned way — it sets the element unmuted BEFORE
 * calling `play()` and reads the returned promise: resolve → the browser granted
 * sound, keep it unmuted; reject → settle to muted playback and leave it. We do
 * NOT fight the policy (no unmuting an already-playing element, which makes the
 * browser yank it to a pause, and no hidden "unmute on first click" gesture that
 * collides with play/pause). When the browser won't allow sound on load, we just
 * live with muted-by-default.
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
  /** Sound was granted: commit unmuted React state, solo audio, persist, flash. */
  onUnmuted: () => void;
  /** Sound was refused: reflect the (already-muted) element in React state.
   *  Leaves the persisted "owner" intent alone so a later reload can try again. */
  onMuted: () => void;
}

/**
 * If this window was the audio owner, try to restore its unmuted state on the
 * given media element. Sets the element unmuted and probes autoplay permission
 * via the `play()` promise (see the module doc): granted → `onUnmuted`; refused
 * → mute + resume muted playback + `onMuted`. No-op when this window wasn't the
 * owner. Returns a cleanup that cancels the pending probe.
 *
 * Doing this BEFORE playback has visibly started (the common case on a cold
 * drive that's still buffering) means the element never plays muted first, so
 * there's no flicker — and no gesture hacks that fight the browser.
 */
export function restoreAudioOwner(
  video: HTMLMediaElement,
  handlers: RestoreHandlers,
): () => void {
  if (!readAudioOwner()) return () => {};

  let cancelled = false;

  // Unmute first, then let play()'s promise report whether the browser permits
  // sound — the sanctioned, flicker-free probe.
  video.muted = false;
  Promise.resolve(video.play()).then(() => {
    if (cancelled) return;
    handlers.onUnmuted(); // browser granted sound → keep it unmuted + solo
  }).catch(() => {
    if (cancelled) return;
    // Browser refused unmuted playback on this fresh load. Settle to muted
    // playback and leave it — we live with muted-by-default rather than
    // hacking around the native autoplay policy.
    video.muted = true;
    handlers.onMuted();
    void video.play().catch(() => {});
  });

  return () => { cancelled = true; };
}
