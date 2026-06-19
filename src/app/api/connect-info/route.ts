/**
 * GET /api/connect-info — the LAN URLs other devices can use to reach this
 * KenNook (mDNS name + IP fallbacks). Powers the "Connect a device" panel.
 * LAN-only information; harmless to expose on the local network.
 */

import { getConnectInfo } from '@/server/discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json(getConnectInfo());
}
