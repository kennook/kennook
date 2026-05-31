/**
 * GET /api/admin/estimate?lib=<slug>
 *
 * Returns per-action pending counts + rough time estimates for the run menu.
 * Powers the "~25 min for 1,357 items" labels and the fastest→slowest chips.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { getRawSqlite } from '@/db/client';
import { parseLibraryCookie } from '@/server/libraries';
import { buildEstimates } from '@/server/admin/estimate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;

  const lib = req.nextUrl.searchParams.get('lib')
    ?? req.nextUrl.searchParams.get('ws')
    ?? parseLibraryCookie(req.headers.get('cookie'));

  try {
    const sqlite = getRawSqlite(lib);
    return Response.json({ estimates: buildEstimates(sqlite) });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
