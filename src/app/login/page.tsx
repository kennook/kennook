'use client';

/**
 * User picker — the Phase-0 "login" UX.
 *
 * Lists every user from /api/auth/users, lets the visitor click one,
 * sets the `kennook_user` cookie via /api/auth/select, and redirects
 * back to wherever they came from (or `/` if no return URL).
 *
 * No passwords; logout = clear the cookie in browser dev tools. Both
 * deliberate per Phase 0. When real auth lands the page survives —
 * it just gets a password field per user, or gets replaced by an
 * OAuth redirect.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface User {
  id: number;
  name: string;
  role: 'viewer' | 'admin';
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') || '/';

  const [users, setUsers] = useState<User[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/users')
      .then((r) => r.json())
      .then((data: User[]) => setUsers(data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function pick(userId: number) {
    setBusy(userId);
    setError(null);
    try {
      const res = await fetch('/api/auth/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `Sign-in failed (${res.status})`);
      }
      router.push(returnTo);
      // Force a re-render so the new cookie is picked up everywhere.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-zinc-900/60 backdrop-blur ring-1 ring-zinc-800
                      rounded-xl p-6 shadow-2xl">
        <h1 className="text-xl font-medium mb-1">Sign in to Kennook</h1>
        <p className="text-sm text-zinc-400 mb-5">Pick an account to continue.</p>

        {!users && !error && (
          <div className="text-sm text-zinc-500">Loading…</div>
        )}
        {error && (
          <div className="text-sm text-red-400 mb-3">{error}</div>
        )}

        {users && (
          <div className="space-y-2">
            {users.map((u) => (
              <button
                key={u.id}
                onClick={() => pick(u.id)}
                disabled={busy !== null}
                className="w-full flex items-center justify-between gap-3
                           bg-zinc-950/60 hover:bg-zinc-800 hover:ring-zinc-700
                           ring-1 ring-zinc-800 rounded-lg px-4 py-3 transition
                           disabled:opacity-50 disabled:cursor-wait text-left"
              >
                <div>
                  <div className="text-sm font-medium text-zinc-100">{u.name}</div>
                  <div className="text-[11px] uppercase tracking-wider text-zinc-500">
                    {u.role}
                  </div>
                </div>
                {busy === u.id ? (
                  <span className="text-xs text-zinc-500">Signing in…</span>
                ) : (
                  <span className="text-zinc-600" aria-hidden>→</span>
                )}
              </button>
            ))}
          </div>
        )}

        <p className="text-[11px] text-zinc-600 mt-5 leading-relaxed">
          Phase-0 sign-in: no password. To switch users, return to this page.
          To sign out, clear your browser cookies for this site.
        </p>
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
