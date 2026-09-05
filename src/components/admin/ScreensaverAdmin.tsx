'use client';

/**
 * The Screensaver admin page body. The master enable/disable switch sits at the
 * top; when it's off the whole feature is disabled everywhere, so the dependent
 * settings (lock passcode, custom clips) are dimmed and inert — they only matter
 * when the screensaver can actually run.
 *
 * The toggle writes the shared `screensaver.enabled` instance config (same key
 * the app reads to gate the S shortcut and the mirror), fanned out live.
 */

import { trpc } from '@/lib/trpc-client';
import { ScreensaverLockSettings } from './ScreensaverLockSettings';
import { CustomScreensaversCard } from './CustomScreensaversCard';

export function ScreensaverAdmin() {
  const utils = trpc.useUtils();
  const config = trpc.config.list.useQuery();
  const enabled = config.data?.find((c) => c.key === 'screensaver.enabled')?.value ?? true;

  const set = trpc.config.set.useMutation({
    onMutate: async ({ key, value }) => {
      await utils.config.list.cancel();
      const prev = utils.config.list.getData();
      utils.config.list.setData(undefined, (old) =>
        old?.map((c) => (c.key === key ? { ...c, value } : c)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.config.list.setData(undefined, ctx.prev); },
    onSettled: () => utils.config.list.invalidate(),
  });

  return (
    <div>
      {/* Master switch */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-md
                      flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-100">Enable screensaver</div>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
            The walk-away screensaver. When off, the <kbd className="text-zinc-400">S</kbd>{' '}
            shortcut and the screensaver are disabled everywhere — the settings
            below don’t apply.
          </p>
        </div>
        <Toggle
          on={enabled}
          disabled={set.isPending || config.isLoading}
          label="Enable screensaver"
          onChange={(value) => set.mutate({ key: 'screensaver.enabled', value })}
        />
      </div>

      {/* Dependent settings — irrelevant while the screensaver is off. */}
      <div
        className={enabled ? '' : 'opacity-40 pointer-events-none select-none'}
        aria-disabled={!enabled}
      >
        <ScreensaverLockSettings />
        <CustomScreensaversCard />
      </div>
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
