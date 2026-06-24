/**
 * App-wide login gate (server component).
 *
 * Every visitor needs a signed session. Unauthenticated → /login, where they
 * sign in to a named account or "Continue anonymously" (which mints a signed
 * session as the shared Viewer). The data layer is gated independently in
 * tRPC (server/trpc.ts), so a client can't skip this by hitting /api/trpc.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { isAuthenticated } from '@/server/auth';
import HomeClient from './HomeClient';

// Auth state must never be statically cached — always evaluate the gate.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const cookieHeader = (await headers()).get('cookie');
  if (!isAuthenticated(cookieHeader)) {
    redirect('/login?returnTo=/');
  }
  return <HomeClient />;
}
