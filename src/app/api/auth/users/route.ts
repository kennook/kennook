/**
 * List all selectable users for the login picker.
 *
 * Phase 0: anyone with network access to this KenNook can see the
 * list (no passwords protect it). That's by design — the security
 * boundary is "you're on my LAN," not the user list itself.
 */

import { listUsers } from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json(listUsers());
}
