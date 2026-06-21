'use client';

/**
 * Instance configuration — renders an on/off switch per item from the config
 * schema (server/app-config.ts). New toggles appear here automatically.
 */

import { trpc } from '@/lib/trpc-client';

export function ConfigurationSettings() {
  const utils = trpc.useUtils();
  const list = trpc.config.list.useQuery();
  const set = trpc.config.set.useMutation({
    // Optimistically flip, then reconcile — keeps the switch snappy.
    onMutate: async ({ key, value }) => {
      await utils.config.list.cancel();
      const prev = utils.config.list.getData();
      utils.config.list.setData(undefined, (old) =>
        old?.map((c) => (c.key === key ? { ...c, value } : c)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) utils.config.list.setData(undefined, ctx.prev);
    },
    onSettled: () => utils.config.list.invalidate(),
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800/70 max-w-xl">
      {list.isLoading && <div className="p-6 text-sm text-zinc-500">Loading…</div>}
      {list.data?.length === 0 && (
        <div className="p-6 text-sm text-zinc-500">No configurable options yet.</div>
      )}
      {list.data?.map((item) => (
        <div key={item.key} className="flex items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-100">{item.label}</div>
            <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{item.description}</p>
          </div>
          <Toggle
            on={item.value}
            disabled={set.isPending}
            onChange={(value) => set.mutate({ key: item.key, value })}
            label={item.label}
          />
        </div>
      ))}
      {set.isError && (
        <div className="px-5 py-2 text-xs text-red-400">
          Couldn’t save — admin access required.
        </div>
      )}
    </div>
  );
}

function Toggle({
  on, onChange, disabled, label,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors
                  disabled:opacity-50 disabled:cursor-not-allowed
                  ${on ? 'bg-emerald-500' : 'bg-zinc-700'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow
                    transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}
