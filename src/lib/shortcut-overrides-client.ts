'use client';

/**
 * Feeds the tenant + user shortcut-override maps from the server into the client
 * resolver (`src/lib/shortcuts.ts`) and keeps them fresh. Mount once, app-wide
 * (HomeClient). Refetches on the `shortcuts.changed` sync event (same browser +
 * same-device other windows) and on `data.changed` (cross-device, via the state
 * poll) so a rebind at any tier re-resolves live.
 */

import { useEffect } from 'react';
import { trpc } from '@/lib/trpc-client';
import { useSyncEvent } from '@/lib/sync';
import { setTenantOverrides, setUserOverrides } from '@/lib/shortcuts';

export function useShortcutOverridesSync(): void {
  const utils = trpc.useUtils();
  const tenant = trpc.shortcuts.getTenant.useQuery(undefined, { staleTime: 60_000 });
  const user = trpc.shortcuts.getUser.useQuery(undefined, { staleTime: 60_000 });

  useEffect(() => { if (tenant.data) setTenantOverrides(tenant.data); }, [tenant.data]);
  useEffect(() => { if (user.data) setUserOverrides(user.data); }, [user.data]);

  useSyncEvent('shortcuts.changed', () => {
    void utils.shortcuts.getTenant.invalidate();
    void utils.shortcuts.getUser.invalidate();
  });
  // Cross-device convergence for this user's own tier (data-rev poll → data.changed).
  useSyncEvent('data.changed', () => {
    void utils.shortcuts.getUser.invalidate();
  });
}
