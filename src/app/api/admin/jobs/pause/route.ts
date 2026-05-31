/**
 * POST /api/admin/jobs/pause   — pause the queue (persisted)
 *
 * Stops the queue from advancing and gracefully stops the running job, which
 * requeues itself with its finished work preserved. The pause flag lives in
 * user.db, so it survives page refresh AND app restart.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { pauseQueue } from '@/server/admin/job-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;
  const result = pauseQueue();
  return Response.json(result);
}
