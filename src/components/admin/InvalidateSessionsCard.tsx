'use client';

/**
 * Admin danger-zone control: rotate the session secret to sign every device
 * out at once. Confirms first (it logs the admin out too), then redirects to
 * /login on success.
 */

import { useState } from 'react';

export function InvalidateSessionsCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!confirm(
      'Sign out every device, including this one? Everyone will have to log in again.',
    )) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/invalidate-all', { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Failed (${res.status})`);
      }
      window.location.href = '/login';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-6 max-w-xl mt-6">
      <h2 className="text-sm font-medium text-red-200 mb-1">Sign out everyone</h2>
      <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
        Rotates the session key, instantly invalidating every signed-in session
        on every device — anonymous and named alike. Everyone, including you, is
        returned to the login screen. Use this if a session may be compromised
        or you want a clean slate. Passwords and accounts are untouched.
      </p>
      {error && <div className="text-xs text-red-400 mb-3">{error}</div>}
      <button
        onClick={run}
        disabled={busy}
        className="text-sm text-red-50 bg-red-600/80 hover:bg-red-600 rounded-md px-3 py-1.5
                   transition disabled:opacity-40"
      >
        {busy ? 'Signing out everyone…' : 'Sign out all sessions'}
      </button>
    </div>
  );
}
