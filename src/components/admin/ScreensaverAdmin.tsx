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

const ROTATE_OPTIONS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  // Short interval for testing the rotation — only offered in dev builds.
  ...(process.env.NODE_ENV === 'development' ? [{ label: '30 sec (dev)', ms: 30_000 }] : []),
  { label: '1 min', ms: 60_000 },
  { label: '5 min', ms: 5 * 60_000 },
  { label: '10 min', ms: 10 * 60_000 },
  { label: '30 min', ms: 30 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '6 hours', ms: 6 * 60 * 60_000 },
  { label: '12 hours', ms: 12 * 60 * 60_000 },
];

export function ScreensaverAdmin() {
  const utils = trpc.useUtils();
  const config = trpc.config.list.useQuery();
  const enabled = config.data?.find((c) => c.key === 'screensaver.enabled')?.value ?? true;
  const softenFilter = config.data?.find((c) => c.key === 'screensaver.filter')?.value ?? true;

  const rotate = trpc.screensaver.rotate.useQuery();
  const rotateMs = rotate.data?.ms ?? 0;
  const setRotate = trpc.screensaver.setRotate.useMutation({
    onMutate: async ({ ms }) => {
      await utils.screensaver.rotate.cancel();
      const prev = utils.screensaver.rotate.getData();
      utils.screensaver.rotate.setData(undefined, { ms });
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.screensaver.rotate.setData(undefined, ctx.prev); },
    onSettled: () => utils.screensaver.rotate.invalidate(),
  });

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
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-2xl
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
        {/* Appearance */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-2xl
                        flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-100">Soften footage</div>
            <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
              Dim and blur the footage so it recedes into the background. Turn off
              to play it at full brightness and sharpness.
            </p>
          </div>
          <Toggle
            on={softenFilter}
            disabled={set.isPending || config.isLoading}
            label="Soften screensaver footage"
            onChange={(value) => set.mutate({ key: 'screensaver.filter', value })}
          />
        </div>

        {/* Auto-rotate */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-2xl
                        flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-100">Auto-rotate</div>
            <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
              With more than one screensaver enabled, fade to black and switch to
              the next one on this interval. Off keeps each screen on its clip.
            </p>
          </div>
          <select
            value={rotateMs}
            onChange={(e) => setRotate.mutate({ ms: Number(e.target.value) })}
            disabled={setRotate.isPending || rotate.isLoading}
            aria-label="Auto-rotate interval"
            className="shrink-0 bg-zinc-900 ring-1 ring-zinc-700 rounded-md px-2 py-1.5 text-sm
                       text-zinc-200 outline-none focus:ring-zinc-500 disabled:opacity-50 cursor-pointer"
          >
            {ROTATE_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>{o.label}</option>
            ))}
          </select>
        </div>

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
