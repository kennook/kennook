/**
 * GET /api/admin/jobs/<id>/stream  — Server-Sent Events feed of a job's
 * live output. Sends:
 *   • event: `snapshot` (initial — the full buffered output so far)
 *   • event: `output`   (each new chunk while the job runs)
 *   • event: `finished` ({status, exitCode}) and closes
 *   • event: `heartbeat` (every 25 s — keeps the connection alive
 *                          through reverse proxies)
 *
 * Multiple admins can subscribe simultaneously. Each gets the same
 * stream — subscriptions are by job id and never fan across jobs.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/server/admin/require-admin';
import { subscribe, getRecentItems } from '@/server/admin/job-runner';
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const write = (event: string, data: string) => {
        // SSE format: each `data:` line appends the value PLUS an
        // implicit '\n' to the event's buffer. So a chunk like
        // "Hello\n" naively encoded becomes `data: Hello\ndata: \n\n`
        // which the client decodes back as "Hello\n\n" — one extra
        // newline per chunk = endless empty lines in the output panel.
        //
        // Fix: strip a trailing newline before splitting on \n so the
        // encoded form has exactly one fewer line than the source,
        // and the implicit '\n' per data line puts it back.
        const stripped = data.endsWith('\n') ? data.slice(0, -1) : data;
        const payload = `event: ${event}\ndata: ${stripped.replace(/\n/g, '\ndata: ')}\n\n`;
        try { controller.enqueue(encoder.encode(payload)); } catch { /* closed */ }
      };

      // 1) Snapshot of current state — lets a late-joining tab catch up.
      //    Includes the rolling buffer so the strip is populated on
      //    first paint, not just after the next progress emit.
      write('snapshot', JSON.stringify({
        status: job.status,
        exitCode: job.exitCode,
        output: job.output,
        progress: job.progress,
        recent: getRecentItems(jobId),
      }));

      // 2) If the job has already finished, push the finished event and
      //    close. No live tail necessary.
      if (job.status !== 'queued' && job.status !== 'running') {
        write('finished', JSON.stringify({
          status: job.status, exitCode: job.exitCode,
        }));
        try { controller.close(); } catch { /* already closed */ }
        return;
      }

      // 3) Live tail. Subscribe to the runner's event channel for this
      //    job; relay output chunks and the eventual finished event.
      let closed = false;
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: heartbeat\ndata: -\n\n`)); }
        catch { /* swallow */ }
      }, 25_000);

      const unsubscribe = subscribe(jobId, {
        onOutput: (chunk) => write('output', chunk),
        onProgress: (envelope) => write('progress', JSON.stringify(envelope)),
        onFinished: (info) => {
          write('finished', JSON.stringify(info));
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        },
      });

      // Client disconnected → clean up.
      req.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      // Stops nginx/proxy from buffering.
      'x-accel-buffering': 'no',
    },
  });
}
