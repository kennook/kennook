'use client';

/**
 * One-time bridge: saved video play positions live in localStorage
 * (per-device, see lib/video-progress.ts), so the server-side backfill:views
 * script can't see them. This runs once in the browser, reads every saved
 * play position, and tells the server to mark those items viewed — closing
 * the gap for videos played BEFORE open→viewed tracking existed.
 *
 * Renders nothing. Guarded by a localStorage flag so it runs at most once;
 * on failure the flag isn't set, so it retries on the next load. Going
 * forward, opening a video marks it viewed in real time, so this is purely
 * a historical catch-up.
 */

import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc-client';

const DONE_FLAG = 'kennook.viewed-backfill.v1';
const PROGRESS_KEY = 'kennook.video-progress.v1';

export function ViewedBackfill() {
  const markBatch = trpc.media.markViewedBatch.useMutation();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(DONE_FLAG)) return;

    let map: Record<string, unknown> = {};
    try { map = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}'); } catch { /* corrupt */ }

    // Keys are "<librarySlug>:<itemUuid>". Slugs never contain ':' but uuids
    // don't either — split on the FIRST colon to be safe.
    const items = Object.keys(map)
      .map((key) => {
        const i = key.indexOf(':');
        if (i <= 0) return null;
        return { librarySlug: key.slice(0, i), uuid: key.slice(i + 1) };
      })
      .filter((x): x is { librarySlug: string; uuid: string } => !!x && x.uuid.length > 0);

    if (items.length === 0) {
      localStorage.setItem(DONE_FLAG, '1');
      return;
    }

    markBatch.mutate({ items }, {
      onSuccess: () => localStorage.setItem(DONE_FLAG, '1'),
      // No flag on error → retried next load.
    });
  }, [markBatch]);

  return null;
}
