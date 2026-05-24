/**
 * POST /api/admin/jobs/<id>/cancel  — request cancellation.
 *
 * For a queued job, marks it canceled without ever running it. For a
 * running job, sends SIGTERM (escalates to SIGKILL after 3s). For any
 * other status (completed/failed/canceled), returns 400.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { cancel } from '@/server/admin/job-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
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
  const result = cancel(jobId);
  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: 400 });
  }
  return Response.json({ ok: true });
}
