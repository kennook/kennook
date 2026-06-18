'use client';

/**
 * Admin control for the screensaver passphrase. Sets, changes, or clears the
 * single app-wide lock that gates dismissing the walk-away screensaver.
 *
 * The passphrase itself never round-trips back to the client — we only read
 * the boolean `enabled` status and write a new value. See
 * `server/screensaver-lock.ts` for the (modest) threat model.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';

export function ScreensaverLockSettings() {
  const utils = trpc.useUtils();
  const status = trpc.screensaverLock.status.useQuery();
  const enabled = status.data?.enabled === true;

  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const setPassword = trpc.screensaverLock.setPassword.useMutation({
    onSuccess: () => {
      utils.screensaverLock.status.invalidate();
      setValue('');
      setConfirm('');
    },
  });

  const mismatch = value.length > 0 && confirm.length > 0 && value !== confirm;
  const canSave = value.length > 0 && value === confirm && !setPassword.isPending;

  const save = () => {
    if (!canSave) return;
    setPassword.mutate({ password: value }, { onSuccess: () => setDone('Passphrase set.') });
  };
  const clear = () => {
    setPassword.mutate({ password: '' }, { onSuccess: () => setDone('Lock removed.') });
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-md">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-medium text-zinc-200">Screensaver lock</h2>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            enabled
              ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
              : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {status.isLoading ? '…' : enabled ? 'On' : 'Off'}
        </span>
      </div>
      <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
        When set, dismissing the screensaver on any device requires this
        passphrase. <span className="text-zinc-400">Remove it to allow
        dismissing without a password.</span> It deters a casual passer-by —
        it is not full account security (that comes later). Ships enabled with
        a default of <code className="text-zinc-300">password</code>; change it
        here.
      </p>

      <div className="flex flex-col gap-2">
        <input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(e) => { setValue(e.target.value); setDone(null); }}
          placeholder={enabled ? 'New passphrase' : 'Passphrase'}
          className="bg-zinc-950 border border-zinc-700 rounded-md px-3 py-2 text-sm
                     outline-none focus:border-zinc-500"
        />
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setDone(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder="Confirm passphrase"
          className={`bg-zinc-950 border rounded-md px-3 py-2 text-sm outline-none
                      ${mismatch ? 'border-red-500/70' : 'border-zinc-700 focus:border-zinc-500'}`}
        />
        {mismatch && <div className="text-xs text-red-400">Passphrases don’t match</div>}

        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={save}
            disabled={!canSave}
            className="bg-zinc-200 text-zinc-900 rounded-md px-3 py-1.5 text-sm font-medium
                       hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {setPassword.isPending ? 'Saving…' : enabled ? 'Change passphrase' : 'Set passphrase'}
          </button>
          {enabled && (
            <button
              onClick={clear}
              disabled={setPassword.isPending}
              className="text-sm text-zinc-400 hover:text-red-300 px-2 py-1.5 transition
                         disabled:opacity-40"
            >
              Remove lock
            </button>
          )}
          {done && <span className="text-xs text-emerald-400 ml-auto">{done}</span>}
        </div>
        {setPassword.isError && (
          <div className="text-xs text-red-400 mt-1">
            Couldn’t save — admin access required.
          </div>
        )}
      </div>
    </div>
  );
}
