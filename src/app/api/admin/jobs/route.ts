/**
 * GET  /api/admin/jobs        — list recent jobs (most recent first)
 * POST /api/admin/jobs        — enqueue a new job
 *
 * Both gated to admins by `requireAdmin`. POST body shape:
 *   { command: string, args: Record<string, string|number|boolean> }
 *
 * `workspace_slug` is extracted from args.workspace if present, so the
 * job catalog UI just submits a flat options object.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { getJobDefinition } from '@/server/admin/job-catalog';
import { enqueue } from '@/server/admin/job-runner';
import { listJobs, type AdminJobRow } from '@/server/admin/job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;
  const jobs = listJobs(100);
  return Response.json({ jobs });
}

export async function POST(req: NextRequest): Promise<Response> {
  const guard = requireAdmin(req);
  if (guard.response) return guard.response;

  let body: { command?: string; args?: Record<string, unknown> };
  try { body = await req.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  if (typeof body.command !== 'string' || !body.command) {
    return Response.json({ error: 'Missing command' }, { status: 400 });
  }
  const def = getJobDefinition(body.command);
  if (!def) {
    return Response.json({ error: `Unknown command: ${body.command}` }, { status: 400 });
  }

  // Validate + coerce args against the job's declared options.
  const rawArgs = body.args ?? {};
  const cleanArgs: Record<string, string | number | boolean> = {};
  for (const opt of def.options) {
    const v = rawArgs[opt.flag];
    if (v === undefined || v === null || v === '') {
      if (opt.required) {
        return Response.json({ error: `${opt.label} is required` }, { status: 400 });
      }
      continue;
    }
    if (opt.type === 'number') {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (!Number.isFinite(n)) {
        return Response.json({ error: `Invalid number for ${opt.flag}` }, { status: 400 });
      }
      cleanArgs[opt.flag] = n;
    } else if (opt.type === 'boolean') {
      cleanArgs[opt.flag] = v === true || v === 'true';
    } else {
      // 'text' and 'workspace' both serialize as string.
      cleanArgs[opt.flag] = String(v);
    }
  }

  const workspaceSlug = typeof cleanArgs.workspace === 'string' ? cleanArgs.workspace : null;
  const job: AdminJobRow = enqueue({
    command: def.id,
    args: cleanArgs,
    workspaceSlug,
    userId: guard.user.id,
  });
  return Response.json({ job });
}
