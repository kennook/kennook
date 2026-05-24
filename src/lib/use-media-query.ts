'use client';

import { useEffect, useState } from 'react';

/**
 * Reactive matchMedia hook. Initial state is computed synchronously from
 * `window.matchMedia` on the client; on SSR it returns `false` (the most
 * common branch — desktop-class viewport). Hydration may flicker once on
 * mobile devices as a result; we accept that in exchange for not needing
 * a separate UA-detection round-trip.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const m = window.matchMedia(query);
    const update = () => setMatches(m.matches);
    update();
    m.addEventListener('change', update);
    return () => m.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** Convention: anything ≤ 768px CSS px is the mobile tree. Matches Tailwind's
 *  `md` breakpoint so any leftover utility classes line up. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 768px)');
}
