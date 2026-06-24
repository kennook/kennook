'use client';

/**
 * Login — three ways in:
 *   • Continue anonymously (if enabled) → the shared Viewer; one pooled
 *     account, so a notice warns that activity is shared.
 *   • Sign in to a named account (private per-user data).
 *   • Create an account (if self-signup is enabled).
 *
 * The available options come from /api/auth/options; named accounts from
 * /api/auth/users (the anonymous Viewer is hidden — that's the "anonymous"
 * button). All sign-in paths set a signed `kennook_user` cookie server-side.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KenNookLogo } from '@/components/KenNookLogo';

interface User { id: number; name: string; role: 'viewer' | 'admin'; hasPassword: boolean }
interface Options { anonymousViewing: boolean; selfSignup: boolean }

const VIEWER_ID = 1; // the shared anonymous account — surfaced as the button, not the list

function LoginContent() {
  const router = useRouter();
  const returnTo = useSearchParams().get('returnTo') || '/';

  const [users, setUsers] = useState<User[] | null>(null);
  const [options, setOptions] = useState<Options>({ anonymousViewing: false, selfSignup: false });
  const [mode, setMode] = useState<'choose' | 'signin' | 'signup'>('choose');
  const [selected, setSelected] = useState<User | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/users').then((r) => r.json()).then(setUsers).catch(() => setUsers([]));
    fetch('/api/auth/options').then((r) => r.json()).then(setOptions).catch(() => {});
  }, []);

  const done = () => { router.push(returnTo); router.refresh(); };
  async function post(url: string, body?: object) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Failed (${res.status})`);
      }
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const named = (users ?? []).filter((u) => u.id !== VIEWER_ID);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-zinc-900/60 backdrop-blur ring-1 ring-zinc-800 rounded-xl p-6 shadow-2xl">
        <div className="mb-5"><KenNookLogo height={28} /></div>
        {error && <div className="text-sm text-red-400 mb-3">{error}</div>}

        {/* ── Choose ─────────────────────────────────────────────── */}
        {mode === 'choose' && (
          <>
            <h1 className="text-xl font-medium mb-1">Welcome</h1>
            <p className="text-sm text-zinc-400 mb-5">Sign in, or continue anonymously.</p>

            {options.anonymousViewing && (
              <div className="mb-4">
                <button
                  onClick={() => post('/api/auth/anonymous')}
                  disabled={busy}
                  className="w-full bg-zinc-200 text-zinc-900 rounded-lg py-2.5 text-sm font-medium
                             hover:bg-white disabled:opacity-50 transition"
                >
                  Continue anonymously
                </button>
                <p className="text-[11px] text-amber-400/90 mt-2 leading-relaxed">
                  Heads up: anonymous viewers all share one account — your likes,
                  view history, and saved searches are visible to everyone else
                  browsing anonymously. Sign in for a private space.
                </p>
              </div>
            )}

            {(named.length > 0 || options.anonymousViewing) && (
              <div className="flex items-center gap-3 my-4 text-[11px] uppercase tracking-wider text-zinc-600">
                <span className="h-px flex-1 bg-zinc-800" />or<span className="h-px flex-1 bg-zinc-800" />
              </div>
            )}

            {named.length > 0 && (
              <div className="space-y-2">
                {named.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => { setSelected(u); setPassword(''); setError(null); setMode(u.hasPassword ? 'signin' : 'choose'); if (!u.hasPassword) void post('/api/auth/select', { userId: u.id }); }}
                    disabled={busy}
                    className="w-full flex items-center justify-between bg-zinc-950/60 hover:bg-zinc-800
                               ring-1 ring-zinc-800 rounded-lg px-4 py-2.5 transition text-left disabled:opacity-50"
                  >
                    <span className="text-sm font-medium">{u.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">{u.role}</span>
                  </button>
                ))}
              </div>
            )}

            {options.selfSignup && (
              <button
                onClick={() => { setMode('signup'); setError(null); setName(''); setPassword(''); }}
                className="w-full text-center text-sm text-zinc-400 hover:text-zinc-100 mt-4 transition"
              >
                Create an account
              </button>
            )}
          </>
        )}

        {/* ── Sign in (named, password) ──────────────────────────── */}
        {mode === 'signin' && selected && (
          <form onSubmit={(e) => { e.preventDefault(); if (!busy) void post('/api/auth/select', { userId: selected.id, password }); }}>
            <h1 className="text-xl font-medium mb-1">{selected.name}</h1>
            <p className="text-sm text-zinc-400 mb-4">Enter the account password.</p>
            <input
              autoFocus type="password" value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Password"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-md px-3 py-2 text-sm outline-none focus:border-zinc-500 mb-3"
            />
            <div className="flex items-center gap-2">
              <button type="submit" disabled={busy || !password}
                className="bg-zinc-200 text-zinc-900 rounded-md px-4 py-2 text-sm font-medium hover:bg-white disabled:opacity-40 transition">
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <button type="button" onClick={() => { setMode('choose'); setError(null); }}
                className="text-sm text-zinc-400 hover:text-zinc-200 px-2 py-2 transition">Back</button>
            </div>
          </form>
        )}

        {/* ── Sign up ────────────────────────────────────────────── */}
        {mode === 'signup' && (
          <form onSubmit={(e) => { e.preventDefault(); if (!busy) void post('/api/auth/signup', { name, password }); }}>
            <h1 className="text-xl font-medium mb-1">Create your account</h1>
            <p className="text-sm text-zinc-400 mb-4">Your likes, searches, and history stay private to you.</p>
            <input
              autoFocus value={name} onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder="Name"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-md px-3 py-2 text-sm outline-none focus:border-zinc-500 mb-2"
            />
            <input
              type="password" autoComplete="new-password" value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Password"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-md px-3 py-2 text-sm outline-none focus:border-zinc-500 mb-3"
            />
            <div className="flex items-center gap-2">
              <button type="submit" disabled={busy || !name.trim() || !password}
                className="bg-zinc-200 text-zinc-900 rounded-md px-4 py-2 text-sm font-medium hover:bg-white disabled:opacity-40 transition">
                {busy ? 'Creating…' : 'Create account'}
              </button>
              <button type="button" onClick={() => { setMode('choose'); setError(null); }}
                className="text-sm text-zinc-400 hover:text-zinc-200 px-2 py-2 transition">Back</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginContent /></Suspense>;
}
