'use client';

/**
 * Admin control for the screensaver passcode — the 4-digit PIN that gates
 * dismissing the walk-away screensaver. Setting it turns the lock on; clearing
 * it turns the lock off for everyone.
 *
 * When the lock is on, a signed-in named user dismisses with their own account
 * password instead of this passcode (see server/screensaver-lock.ts). The
 * passcode itself never round-trips back to the client — we only read the
 * boolean `enabled` status and write a new value.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { PinInput } from '@/components/PinInput';

// Kept in sync with PASSCODE_LENGTH in server/screensaver-lock.ts (can't
// import it — that module pulls in server-only code).
const LENGTH = 4;

export function ScreensaverLockSettings() {
  const utils = trpc.useUtils();
  const status = trpc.screensaverLock.status.useQuery();
  const enabled = status.data?.enabled === true;

  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const setPasscode = trpc.screensaverLock.setPasscode.useMutation({
    onSuccess: () => {
      utils.screensaverLock.status.invalidate();
      setValue('');
      setConfirm('');
    },
  });

  const mismatch = confirm.length === LENGTH && value !== confirm;
  const canSave = value.length === LENGTH && value === confirm && !setPasscode.isPending;

  const save = () => {
    if (!canSave) return;
    setPasscode.mutate({ passcode: value }, { onSuccess: () => setDone('Passcode set.') });
  };
  const clear = () => {
    setPasscode.mutate({ passcode: '' }, { onSuccess: () => setDone('Lock removed.') });
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
      <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
        A 4-digit passcode to dismiss the screensaver on shared or anonymous
        displays.{' '}
        <span className="text-zinc-400">Signed-in users dismiss with their own
        account password instead — they’re never asked for this passcode.</span>{' '}
        Remove it to let any device dismiss without unlocking. Ships on with a
        default of <code className="text-zinc-300">1234</code> — change it here.
      </p>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-xs text-zinc-400">{enabled ? 'New passcode' : 'Passcode'}</span>
          <PinInput value={value} onChange={(v) => { setValue(v); setDone(null); }} ariaLabel="New passcode" />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-zinc-400">Confirm passcode</span>
          <PinInput
            value={confirm}
            onChange={(v) => { setConfirm(v); setDone(null); }}
            onComplete={save}
            error={mismatch}
            ariaLabel="Confirm passcode"
          />
          {mismatch && <div className="text-xs text-red-400 text-center">Passcodes don’t match</div>}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={!canSave}
            className="bg-zinc-200 text-zinc-900 rounded-md px-3 py-1.5 text-sm font-medium
                       hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {setPasscode.isPending ? 'Saving…' : enabled ? 'Change passcode' : 'Set passcode'}
          </button>
          {enabled && (
            <button
              onClick={clear}
              disabled={setPasscode.isPending}
              className="text-sm text-zinc-400 hover:text-red-300 px-2 py-1.5 transition
                         disabled:opacity-40"
            >
              Remove lock
            </button>
          )}
          {done && <span className="text-xs text-emerald-400 ml-auto">{done}</span>}
        </div>
        {setPasscode.isError && (
          <div className="text-xs text-red-400">{setPasscode.error.message}</div>
        )}
      </div>
    </div>
  );
}
