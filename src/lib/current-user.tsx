'use client';

/**
 * Client-side current-user context.
 *
 * Loads once on mount from /api/auth/me and exposes the result via a
 * React context, so multiple components can check `useCurrentUser()`
 * without each firing its own fetch.
 *
 * Refreshes on demand via `refresh()` — call this after switching
 * accounts at /login so admin-gated UI re-renders without a full
 * reload. The login flow also does `router.refresh()` which
 * re-fetches server components; this hook covers client components.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type UserRole = 'viewer' | 'admin';

export interface CurrentUser {
  id: number;
  name: string;
  role: UserRole;
}

interface Ctx {
  user: CurrentUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const CurrentUserContext = createContext<Ctx>({
  user: null,
  loading: true,
  refresh: async () => {},
});

export function CurrentUserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!res.ok) throw new Error(`/api/auth/me ${res.status}`);
      const u = await res.json() as CurrentUser;
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo(() => ({ user, loading, refresh }), [user, loading, refresh]);
  return (
    <CurrentUserContext.Provider value={value}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser() {
  return useContext(CurrentUserContext);
}

/** Convenience: true iff the current user is signed in as an admin. */
export function useIsAdmin(): boolean {
  return useCurrentUser().user?.role === 'admin';
}
