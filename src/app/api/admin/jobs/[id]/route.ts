/**
 * GET /api/admin/jobs/<id>  — single job's full state including output.
 *
 * Use the /stream endpoint for live tail; use this one to refresh the
 * panel on load (so reopening a tab restores the output buffer that
 * was streamed before).
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { getJob } from '@/server/admin/job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;
  const { id } = await ctx.params;
  const jobId = parseInt(id, 10);
  if (!Number.isInteger(jobId)) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }
  const job = getJob(jobId);
  if (!job) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ job });
}
