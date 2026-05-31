/**
 * POST /api/admin/jobs/resume   — resume a paused queue
 *
 * Clears the persisted pause flag and kicks the worker. Queued + previously
 * paused steps resume in order; finished items are skipped by each script's
 * per-item status check.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { resumeQueue } from '@/server/admin/job-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;
  const result = resumeQueue();
  return Response.json(result);
}
