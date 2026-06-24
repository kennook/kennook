/**
 * GET /api/auth/options — what the login page is allowed to offer. Public
 * (the login page is reached before any session exists). LAN-only info.
 */

import { getConfigValue } from '@/server/app-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json({
    anonymousViewing: getConfigValue('auth.anonymousViewing'),
    selfSignup: getConfigValue('auth.selfSignup'),
  });
}
