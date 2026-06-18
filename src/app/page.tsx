/**
 * App-wide login gate (server component).
 *
 * When the default Viewer account has a password (isAuthGateEnabled), an
 * unauthenticated visitor is redirected to /login. Otherwise — gate off —
 * the app is open exactly as before. The actual UI lives in HomeClient.
 *
 * The data layer is gated independently in tRPC (see server/trpc.ts), so a
 * client can't skip this by hitting /api/trpc directly.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { isAuthGateEnabled, isAuthenticated } from '@/server/auth';
import HomeClient from './HomeClient';

// Auth state must never be statically cached — always evaluate the gate.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const cookieHeader = (await headers()).get('cookie');
  if (isAuthGateEnabled() && !isAuthenticated(cookieHeader)) {
    redirect('/login?returnTo=/');
  }
  return <HomeClient />;
}
