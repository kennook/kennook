'use client';

/**
 * Processor-load throttle for the long-running AI enrichment passes. Lets the
 * operator trade wall-clock time for lower CPU load without touching a config
 * file. Backed by config.throttle / config.setThrottle.
 *
 * Two caveats surfaced to the user:
 *   - The CORE cap takes effect on the NEXT job to start (a model's thread
 *     count is fixed when its session loads).
 *   - The PACING takes effect live on a running job.
 */

import { trpc } from '@/lib/trpc-client';

export function ProcessorLoadControl() {
  const utils = trpc.useUtils();
  const q = trpc.config.throttle.useQuery();
  const set = trpc.config.setThrottle.useMutation({
    onSuccess: () => utils.config.throttle.invalidate(),
  });

  if (!q.data) return null;
  const { level, presets } = q.data;
  const current = presets.find((p) => p.level === level);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-xs uppercase tracking-wider text-zinc-500">Processor load</span>
      <div className="inline-flex rounded-md ring-1 ring-zinc-800 overflow-hidden">
        {presets.map((p) => {
          const active = p.level === level;
          return (
            <button
              key={p.level}
              type="button"
              title={p.hint}
              disabled={set.isPending}
              onClick={() => { if (!active) set.mutate({ level: p.level }); }}
              className={`px-3 py-1.5 text-xs transition disabled:opacity-50
                ${active
                  ? 'bg-emerald-700 text-emerald-50'
                  : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {current && <span className="text-xs text-zinc-500">{current.hint}</span>}
      {level !== 'full' && (
        <span className="text-[11px] text-zinc-600">
          Core limit applies to the next job started; pacing applies live.
        </span>
      )}
    </div>
  );
}
