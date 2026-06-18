'use client';

/**
 * Admin: per-user login passwords. Set, change, or clear each account's
 * password. Clearing the Viewer's password turns the whole-app login gate
 * OFF; clearing Admin's password lets anyone pick the admin account without
 * one — both are flagged inline.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';

interface LoginUser {
  id: number;
  name: string;
  role: 'viewer' | 'admin';
  hasPassword: boolean;
}

export function UserPasswordsSettings() {
  const utils = trpc.useUtils();
  const list = trpc.users.list.useQuery();

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-xl">
      <h2 className="text-sm font-medium text-zinc-200 mb-1">Login passwords</h2>
      <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
        When the <span className="text-zinc-300">Viewer</span> account has a
        password, every device must sign in to use KenNook. A signed-in session
        is required to read the library at all.
      </p>

      <div className="flex flex-col divide-y divide-zinc-800/70">
        {list.data?.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            onSaved={() => utils.users.list.invalidate()}
          />
        ))}
        {list.isLoading && <div className="text-sm text-zinc-500 py-2">Loading…</div>}
      </div>
    </div>
  );
}

function UserRow({ user, onSaved }: { user: LoginUser; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const setPassword = trpc.users.setPassword.useMutation({
    onSuccess: () => { onSaved(); setEditing(false); setValue(''); },
  });

  const save = () => {
    if (value.trim().length === 0 || setPassword.isPending) return;
    setNote('Password updated.');
    setPassword.mutate({ userId: user.id, password: value });
  };
  const clear = () => {
    setNote(user.role === 'viewer' ? 'Cleared — login gate is now off.' : 'Password removed.');
    setPassword.mutate({ userId: user.id, password: '' });
  };

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-zinc-100">{user.name}</div>
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">{user.role}</div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              user.hasPassword
                ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {user.hasPassword ? 'Password set' : 'No password'}
          </span>
          <button
            onClick={() => { setEditing((v) => !v); setNote(null); setValue(''); }}
            className="text-xs text-zinc-300 hover:text-white px-2 py-1 rounded
                       ring-1 ring-zinc-700 hover:ring-zinc-500 transition"
          >
            {user.hasPassword ? 'Change' : 'Set'}
          </button>
          {user.hasPassword && (
            <button
              onClick={clear}
              disabled={setPassword.isPending}
              className="text-xs text-zinc-400 hover:text-red-300 px-2 py-1 transition disabled:opacity-40"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
            placeholder={`New password for ${user.name}`}
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded-md px-3 py-1.5 text-sm
                       outline-none focus:border-zinc-500"
          />
          <button
            onClick={save}
            disabled={value.trim().length === 0 || setPassword.isPending}
            className="bg-zinc-200 text-zinc-900 rounded-md px-3 py-1.5 text-sm font-medium
                       hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            Save
          </button>
        </div>
      )}

      {note && !editing && <div className="mt-1 text-xs text-emerald-400">{note}</div>}
      {user.role === 'admin' && !user.hasPassword && (
        <div className="mt-1 text-xs text-amber-400/90">
          Admin has no password — anyone can sign in as admin.
        </div>
      )}
    </div>
  );
}
