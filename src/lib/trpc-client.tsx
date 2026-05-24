'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { useState } from 'react';
import superjson from 'superjson';
import type { AppRouter } from '@/server/routers/_app';
import { PreferencesProvider } from '@/lib/preferences';
import { CurrentUserProvider } from '@/lib/current-user';
import { SyncProvider, SESSION_ID } from '@/lib/sync';

export const trpc = createTRPCReact<AppRouter>();

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: '/api/trpc',
          transformer: superjson,
          // Per-request headers:
          //   x-kennook-session   — stable per-tab id; lets server-published
          //                         sync events be skipped by their originator.
          //   x-kennook-workspace — pulled fresh from window.location each
          //                         time, so changing `?ws=` mid-session
          //                         routes the next request to the right
          //                         workspace without re-creating the client.
          headers() {
            const headers: Record<string, string> = {
              'x-kennook-session': SESSION_ID,
            };
            if (typeof window !== 'undefined') {
              const ws = new URLSearchParams(window.location.search).get('ws');
              if (ws) headers['x-kennook-workspace'] = ws;
            }
            return headers;
          },
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <PreferencesProvider>
          <CurrentUserProvider>
            <SyncProvider>{children}</SyncProvider>
          </CurrentUserProvider>
        </PreferencesProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
