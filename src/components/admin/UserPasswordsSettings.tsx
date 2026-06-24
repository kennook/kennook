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
      <h2 className="text-sm font-medium text-zinc-200 mb-1">Accounts</h2>
      <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
        Each named account gets its own private likes, view history, and saved
        searches. Anonymous viewers share the{' '}
        <span className="text-zinc-300">Viewer</span> account. (Let people make
        their own accounts via <span className="text-zinc-300">Configuration →
        Self-service signup</span>.)
      </p>

      <CreateUser onCreated={() => utils.users.list.invalidate()} />

      <div className="flex flex-col divide-y divide-zinc-800/70 mt-4">
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

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const create = trpc.users.create.useMutation({
    onSuccess: () => { onCreated(); setOpen(false); setName(''); setPassword(''); },
  });
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-sm text-zinc-300 hover:text-white ring-1 ring-zinc-700 hover:ring-zinc-500
                   rounded-md px-3 py-1.5 transition"
      >
        + New account
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (name.trim() && password && !create.isPending) create.mutate({ name: name.trim(), password, role: 'viewer' }); }}
      className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3"
    >
      <div className="flex gap-2">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
          className="flex-1 bg-zinc-950 border border-zinc-700 rounded-md px-3 py-1.5 text-sm outline-none focus:border-zinc-500" />
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password"
          className="flex-1 bg-zinc-950 border border-zinc-700 rounded-md px-3 py-1.5 text-sm outline-none focus:border-zinc-500" />
      </div>
      {create.isError && <div className="text-xs text-red-400">{create.error.message}</div>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={!name.trim() || !password || create.isPending}
          className="bg-zinc-200 text-zinc-900 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-white disabled:opacity-40 transition">
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setName(''); setPassword(''); }}
          className="text-sm text-zinc-400 hover:text-zinc-200 px-2 py-1.5 transition">Cancel</button>
      </div>
    </form>
  );
}

function UserRow({ user, onSaved }: { user: LoginUser; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const protectedUser = user.id === 1 || user.id === 2; // Viewer + Admin

  const setPassword = trpc.users.setPassword.useMutation({
    onSuccess: () => { onSaved(); setEditing(false); setValue(''); },
  });
  const remove = trpc.users.delete.useMutation({ onSuccess: () => onSaved() });

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
              Clear pw
            </button>
          )}
          {!protectedUser && (
            <button
              onClick={() => { if (confirm(`Delete ${user.name}? Their likes, history, and saved searches are removed.`)) remove.mutate({ userId: user.id }); }}
              disabled={remove.isPending}
              title="Delete account"
              className="text-xs text-zinc-500 hover:text-red-400 px-2 py-1 transition disabled:opacity-40"
            >
              Delete
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
