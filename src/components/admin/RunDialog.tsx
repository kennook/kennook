'use client';

/**
 * Modal form for running a job. Renders one input per option in the
 * job's definition; submits the args object back to the parent which
 * enqueues via /api/admin/jobs.
 *
 * Workspace options are a select populated from the workspace list
 * passed in by the parent. Number options are <input type="number">.
 * Boolean options are checkboxes.
 */

import { useMemo, useState } from 'react';
import type { JobDefinition } from '@/server/admin/job-catalog';
import { validateJobArgs } from './job-validators';

export function RunDialog({
  definition,
  workspaces,
  onSubmit,
  onCancel,
}: {
  definition: JobDefinition;
  workspaces: { slug: string; name: string }[];
  onSubmit: (args: Record<string, string | number | boolean>) => void | Promise<void>;
  onCancel: () => void;
}) {
  // Initial form values: empty / false / default for each option.
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    const v: Record<string, string | number | boolean> = {};
    for (const opt of definition.options) {
      if (opt.type === 'boolean') v[opt.flag] = false;
      else if (opt.defaultValue !== undefined) v[opt.flag] = opt.defaultValue;
      else if (opt.type === 'workspace' && workspaces[0]) v[opt.flag] = workspaces[0].slug;
      else v[opt.flag] = '';
    }
    return v;
  });
  const [submitting, setSubmitting] = useState(false);

  // Live cross-field validation — re-runs as the user edits. The
  // submit button is disabled while this is non-null.
  const validationError = useMemo(
    () => validateJobArgs(definition.id, values),
    [definition.id, values],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validationError) return;
    setSubmitting(true);
    try {
      await onSubmit(values);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-zinc-900 ring-1 ring-zinc-800 rounded-xl shadow-2xl
                   w-full max-w-md p-6"
      >
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <h2 className="text-base font-medium text-zinc-100">{definition.label}</h2>
          <span className="font-mono text-[10px] text-zinc-600">{definition.id}</span>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed mb-5">{definition.description}</p>

        {definition.longRunning && (
          <div className="text-[11px] text-amber-300 bg-amber-950/30 ring-1 ring-amber-900/40
                          rounded px-3 py-2 mb-4">
            ⏱ This job is typically long-running. It will block the queue until done.
          </div>
        )}

        <div className="space-y-3 mb-5">
          {definition.options.map((opt) => (
            <div key={opt.flag}>
              <label className="block text-xs text-zinc-400 mb-1">
                {opt.label}
                {opt.help && <span className="text-zinc-600 ml-1.5">— {opt.help}</span>}
              </label>
              {opt.type === 'workspace' ? (
                <select
                  value={String(values[opt.flag] ?? '')}
                  onChange={(e) => setValues({ ...values, [opt.flag]: e.target.value })}
                  className="w-full bg-zinc-950 ring-1 ring-zinc-800 focus:ring-zinc-600
                             rounded px-3 py-2 text-sm text-zinc-100 outline-none transition"
                >
                  <option value="">(omit — script default)</option>
                  {workspaces.map((w) => (
                    <option key={w.slug} value={w.slug}>{w.name}</option>
                  ))}
                </select>
              ) : opt.type === 'number' ? (
                <input
                  type="number"
                  value={values[opt.flag] === '' ? '' : String(values[opt.flag] ?? '')}
                  onChange={(e) => setValues({
                    ...values,
                    [opt.flag]: e.target.value === '' ? '' : Number(e.target.value),
                  })}
                  placeholder={opt.placeholder ?? '(omit)'}
                  className="w-full bg-zinc-950 ring-1 ring-zinc-800 focus:ring-zinc-600
                             rounded px-3 py-2 text-sm text-zinc-100 outline-none transition"
                />
              ) : opt.type === 'text' ? (
                <input
                  type="text"
                  value={String(values[opt.flag] ?? '')}
                  onChange={(e) => setValues({ ...values, [opt.flag]: e.target.value })}
                  placeholder={opt.placeholder ?? '(omit)'}
                  className="w-full bg-zinc-950 ring-1 ring-zinc-800 focus:ring-zinc-600
                             rounded px-3 py-2 text-sm text-zinc-100 outline-none transition
                             font-mono"
                />
              ) : (
                <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!values[opt.flag]}
                    onChange={(e) => setValues({ ...values, [opt.flag]: e.target.checked })}
                    className="accent-emerald-400"
                  />
                  enabled
                </label>
              )}
            </div>
          ))}
          {definition.options.length === 0 && (
            <div className="text-xs text-zinc-500">No options — just run it.</div>
          )}
        </div>

        {validationError && (
          <div className="text-[11px] text-amber-300 bg-amber-950/30 ring-1 ring-amber-900/40
                          rounded px-3 py-2 mb-4">
            {validationError}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || validationError !== null}
            className="px-4 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 rounded
                       text-emerald-50 transition disabled:opacity-50
                       disabled:cursor-not-allowed"
          >
            {submitting ? 'Enqueuing…' : 'Run'}
          </button>
        </div>
      </form>
    </div>
  );
}
