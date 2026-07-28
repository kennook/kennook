/**
 * Resiliently resume a <video> that was paused (e.g. by the screensaver).
 *
 * `video.play()` returns a promise that REJECTS when the element isn't ready —
 * which is common right after a screensaver dismiss if the source drive has spun
 * down or a live stream is re-buffering (low `readyState`). A bare `play()` there
 * fails silently and the video stays paused. This retries a few times (and on the
 * `canplay` signal) so playback catches on once the drive/stream wakes up, while
 * giving up quietly if it genuinely can't play.
 */
export function resumePlayback(video: HTMLVideoElement, maxTries = 6): () => void {
  let tries = 0;
  let done = false;
  let timer = 0;

  const cleanup = () => {
    video.removeEventListener('canplay', onCanPlay);
    if (timer) { window.clearTimeout(timer); timer = 0; }
  };
  const finish = () => { done = true; cleanup(); };
  const onCanPlay = () => { if (!done) attempt(); };

  const attempt = () => {
    if (done) return;
    video.play().then(finish).catch(() => {
      if (done) return; // canceled (e.g. re-suspended) → stop, don't fight pause()
      if (tries++ >= maxTries) { cleanup(); return; }
      timer = window.setTimeout(attempt, 500);
    });
  };

  // Retry sooner if the element signals it can play; otherwise on a timer.
  video.addEventListener('canplay', onCanPlay);
  attempt();

  // Cancel: stop retrying (used when the screensaver re-engages or on unmount).
  return () => { if (!done) { done = true; cleanup(); } };
}
