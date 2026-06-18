'use client';

/**
 * User picker + password — the Phase-0.5 "login" UX.
 *
 * Lists every user from /api/auth/users. Accounts without a password sign in
 * on a single click (legacy behavior); accounts WITH a password open an
 * inline passphrase form that posts to /api/auth/select. On success the
 * server sets a signed `kennook_user` cookie and we return to where we came
 * from (or `/`).
 *
 * When real auth lands this page survives — it just swaps the picker for an
 * OAuth redirect or a username field.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KenNookLogo } from '@/components/KenNookLogo';

interface User {
  id: number;
  name: string;
  role: 'viewer' | 'admin';
  hasPassword: boolean;
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') || '/';

  const [users, setUsers] = useState<User[] | null>(null);
  const [selected, setSelected] = useState<User | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/users')
      .then((r) => r.json())
      .then((data: User[]) => setUsers(data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function signIn(user: User, pw: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: user.id, password: pw }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Sign-in failed (${res.status})`);
      }
      router.push(returnTo);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function choose(user: User) {
    setError(null);
    if (user.hasPassword) {
      setSelected(user);
      setPassword('');
    } else {
      void signIn(user, '');
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-zinc-900/60 backdrop-blur ring-1 ring-zinc-800
                      rounded-xl p-6 shadow-2xl">
        <div className="mb-4">
          <KenNookLogo height={28} />
        </div>

        {!selected ? (
          <>
            <h1 className="text-xl font-medium mb-1">Sign in</h1>
            <p className="text-sm text-zinc-400 mb-5">Pick an account to continue.</p>

            {!users && !error && <div className="text-sm text-zinc-500">Loading…</div>}
            {error && <div className="text-sm text-red-400 mb-3">{error}</div>}

            {users && (
              <div className="space-y-2">
                {users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => choose(u)}
                    disabled={busy}
                    className="w-full flex items-center justify-between gap-3
                               bg-zinc-950/60 hover:bg-zinc-800 hover:ring-zinc-700
                               ring-1 ring-zinc-800 rounded-lg px-4 py-3 transition
                               disabled:opacity-50 disabled:cursor-wait text-left"
                  >
                    <div>
                      <div className="text-sm font-medium text-zinc-100">{u.name}</div>
                      <div className="text-[11px] uppercase tracking-wider text-zinc-500">
                        {u.role}{u.hasPassword ? ' · password' : ''}
                      </div>
                    </div>
                    <span className="text-zinc-600" aria-hidden>→</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); if (!busy) void signIn(selected, password); }}
          >
            <h1 className="text-xl font-medium mb-1">{selected.name}</h1>
            <p className="text-sm text-zinc-400 mb-4">Enter the account password.</p>

            <input
              autoFocus
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Password"
              aria-label="Account password"
              className={`w-full bg-zinc-950 border rounded-md px-3 py-2 text-sm outline-none mb-3
                          ${error ? 'border-red-500/70' : 'border-zinc-700 focus:border-zinc-500'}`}
            />
            {error && <div className="text-sm text-red-400 mb-3">{error}</div>}

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={busy || password.length === 0}
                className="bg-zinc-200 text-zinc-900 rounded-md px-4 py-2 text-sm font-medium
                           hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => { setSelected(null); setPassword(''); setError(null); }}
                disabled={busy}
                className="text-sm text-zinc-400 hover:text-zinc-200 px-2 py-2 transition"
              >
                Back
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
