/**
 * GET /api/admin/jobs/catalog  — list of every runnable job in the
 * catalog (used to render the cards on /admin/indexing).
 *
 * Workspace dropdown is populated client-side from a separate tRPC
 * query the app already has — keeps this endpoint pure config.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { JOB_CATALOG } from '@/server/admin/job-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;
  return Response.json({ catalog: JOB_CATALOG });
}
