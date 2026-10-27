'use client';

/**
 * Admin control for the screensaver lock — the shared secret that gates
 * dismissing the walk-away screensaver on shared or anonymous displays. The
 * admin chooses the kind of secret:
 *
 *   • Passcode — a numeric PIN; pick the length (adjust on the fly) and type the
 *     digits into the boxes.
 *   • Password — a free-form password, entered with a confirmation field.
 *
 * Setting one turns the lock on; clearing it turns the lock off for everyone.
 * A signed-in named user always dismisses with their own account password
 * instead (see server/screensaver-lock.ts); this is only the shared secret for
 * the anonymous/kiosk path. Only the salted hash is stored — nothing round-trips
 * back to the client.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { PinInput } from '@/components/PinInput';

// Kept in sync with the bounds in server/screensaver-lock.ts (can't import —
// that module pulls in server-only code).
const MIN_LENGTH = 4;
const MAX_LENGTH = 32;
const DEFAULT_LENGTH = 6;
const PASSWORD_MIN_LENGTH = 4;

type SecretType = 'passcode' | 'password';

export function ScreensaverLockSettings() {
  const utils = trpc.useUtils();
  const status = trpc.screensaverLock.status.useQuery();
  const enabled = status.data?.enabled === true;
  const storedType = status.data?.secretType ?? 'passcode';
  const storedLength = status.data?.length ?? DEFAULT_LENGTH;

  // Null = follow the stored value; non-null = the admin's in-progress choice.
  // Reset to null after saving so the form tracks the new stored state.
  const [pickedType, setPickedType] = useState<SecretType | null>(null);
  const [pickedLength, setPickedLength] = useState<number | null>(null);
  const type = pickedType ?? storedType;
  const length = pickedLength ?? storedLength;

  const [code, setCode] = useState('');          // passcode digits
  const [pw, setPw] = useState('');               // password
  const [confirm, setConfirm] = useState('');     // password confirmation
  const [done, setDone] = useState<string | null>(null);

  const setSecret = trpc.screensaverLock.setSecret.useMutation({
    onSuccess: () => utils.screensaverLock.status.invalidate(),
  });

  const resetEntries = () => { setCode(''); setPw(''); setConfirm(''); };

  const chooseType = (t: SecretType) => {
    setPickedType(t);
    resetEntries();
    setDone(null);
  };

  const clampLength = (n: number) => Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, Math.round(n || 0)));
  const changeLength = (n: number) => {
    const next = clampLength(n);
    setPickedLength(next);
    setCode((c) => c.slice(0, next)); // keep digits that still fit
    setDone(null);
  };

  const pwMismatch = confirm.length > 0 && pw !== confirm;
  const canSave = type === 'passcode'
    ? code.length === length && !setSecret.isPending
    : pw.length >= PASSWORD_MIN_LENGTH && pw === confirm && !setSecret.isPending;

  const afterSave = (msg: string) => {
    resetEntries();
    setPickedType(null);
    setPickedLength(null);
    setDone(msg);
  };

  const save = () => {
    if (!canSave) return;
    const value = type === 'passcode' ? code : pw;
    setSecret.mutate({ type, value }, { onSuccess: () => afterSave('Lock set.') });
  };

  const clear = () => {
    setSecret.mutate({ type, value: '' }, { onSuccess: () => afterSave('Lock removed.') });
  };

  const statusLabel = status.isLoading
    ? '…'
    : enabled
      ? (storedType === 'password' ? 'On · password' : `On · ${storedLength} digits`)
      : 'Off';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-medium text-zinc-200">Screensaver lock</h2>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            enabled
              ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
              : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {statusLabel}
        </span>
      </div>
      <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
        The secret to dismiss the screensaver on shared or anonymous displays.{' '}
        <span className="text-zinc-400">Signed-in users dismiss with their own
        account password instead — they’re never asked for this.</span>{' '}
        Remove it to let any device dismiss without unlocking.
      </p>

      <div className="flex flex-col gap-4">
        {/* Secret-type picker */}
        <div className="flex items-center gap-5">
          <RadioOption
            name="screensaver-secret-type"
            checked={type === 'passcode'}
            onChange={() => chooseType('passcode')}
            label="Passcode"
            hint="Numeric PIN"
          />
          <RadioOption
            name="screensaver-secret-type"
            checked={type === 'password'}
            onChange={() => chooseType('password')}
            label="Password"
            hint="Free-form text"
          />
        </div>

        {type === 'passcode' ? (
          <>
            {/* Length stepper */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-400">Length</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => changeLength(length - 1)}
                  disabled={length <= MIN_LENGTH}
                  aria-label="Decrease length"
                  className="w-7 h-7 rounded-md bg-zinc-900 ring-1 ring-zinc-700 text-zinc-300
                             hover:ring-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  −
                </button>
                <span className="w-8 text-center text-sm text-zinc-200 tabular-nums">{length}</span>
                <button
                  type="button"
                  onClick={() => changeLength(length + 1)}
                  disabled={length >= MAX_LENGTH}
                  aria-label="Increase length"
                  className="w-7 h-7 rounded-md bg-zinc-900 ring-1 ring-zinc-700 text-zinc-300
                             hover:ring-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  +
                </button>
              </div>
              <span className="text-[11px] text-zinc-600">{MIN_LENGTH}–{MAX_LENGTH} digits</span>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs text-zinc-400">{enabled ? 'New passcode' : 'Passcode'}</span>
              <PinInput
                key={`len${length}`}
                value={code}
                length={length}
                onChange={(v) => { setCode(v); setDone(null); }}
                onComplete={save}
                autoFocus
                ariaLabel="Passcode"
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-zinc-400">{enabled ? 'New password' : 'Password'}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={pw}
                onChange={(e) => { setPw(e.target.value); setDone(null); }}
                placeholder="Password"
                aria-label="Password"
                className="bg-zinc-900 border border-zinc-700 focus:border-zinc-500 rounded-md
                           px-3 py-2 text-sm outline-none max-w-xs"
              />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-zinc-400">Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setDone(null); }}
                placeholder="Confirm password"
                aria-label="Confirm password"
                className={`bg-zinc-900 border rounded-md px-3 py-2 text-sm outline-none max-w-xs
                            ${pwMismatch ? 'border-red-500/70' : 'border-zinc-700 focus:border-zinc-500'}`}
              />
              {pwMismatch && <span className="text-xs text-red-400">Passwords don’t match</span>}
              {pw.length > 0 && pw.length < PASSWORD_MIN_LENGTH && (
                <span className="text-xs text-zinc-500">At least {PASSWORD_MIN_LENGTH} characters.</span>
              )}
            </div>
          </>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={save}
            disabled={!canSave}
            className="bg-zinc-200 text-zinc-900 rounded-md px-3 py-1.5 text-sm font-medium
                       hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {setSecret.isPending ? 'Saving…' : enabled ? 'Change lock' : 'Set lock'}
          </button>
          {enabled && (
            <button
              onClick={clear}
              disabled={setSecret.isPending}
              className="text-sm text-zinc-400 hover:text-red-300 px-2 py-1.5 transition
                         disabled:opacity-40"
            >
              Remove lock
            </button>
          )}
          {done && <span className="text-xs text-emerald-400 ml-auto">{done}</span>}
        </div>
        {setSecret.isError && (
          <div className="text-xs text-red-400">{setSecret.error.message}</div>
        )}
      </div>
    </div>
  );
}

function RadioOption({
  name, checked, onChange, label, hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="accent-emerald-500 w-4 h-4"
      />
      <span className="text-sm text-zinc-200">{label}</span>
      <span className="text-[11px] text-zinc-500">{hint}</span>
    </label>
  );
}
