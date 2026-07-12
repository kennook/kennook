'use client';

/**
 * A per-window sticky boolean, persisted in `sessionStorage`.
 *
 * Unlike the cross-tab Preferences store (which mirrors changes to every
 * same-origin window via a `storage` listener), this is isolated to a single
 * window: `sessionStorage` isn't shared between tabs/windows and fires no
 * cross-tab `storage` events. The value survives a reload of THIS window but
 * never leaks to the others — use it for settings that must be independent per
 * screen in multi-window use (e.g. per-screen video loop).
 */

import { useCallback, useEffect, useState } from 'react';

export function useSessionFlag(key: string, initial = false) {
  const [value, setValue] = useState(initial);

  // Read after mount so the server render and the first client render both use
  // `initial` (no hydration mismatch); the stored value applies right after.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw != null) setValue(raw === '1');
    } catch { /* sessionStorage unavailable (private mode / sandboxed) */ }
  }, [key]);

  const set = useCallback((v: boolean) => {
    setValue(v);
    try { sessionStorage.setItem(key, v ? '1' : '0'); } catch { /* noop */ }
  }, [key]);

  return [value, set] as const;
}
