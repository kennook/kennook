'use client';

/**
 * Header sign-out control. Shows the current account name and, on click,
 * clears the session cookie and hard-navigates to /login (a full reload so
 * no per-user client state — caches, SSE — survives the switch).
 *
 * Visible for every signed-in user, including anonymous viewers (the shared
 * Viewer) — for them it doubles as the path to sign into a named account.
 */

import { useCurrentUser } from '@/lib/current-user';
import { SIDEBAR_ROW } from '@/components/ui/sidebar-row';

export function SignOutButton({ variant = 'header' }: { variant?: 'header' | 'sidebar' } = {}) {
  const { user } = useCurrentUser();
  if (!user) return null;

  const signOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Even if the POST fails, the redirect below lands on the gate.
    }
    window.location.href = '/login';
  };

  if (variant === 'sidebar') {
    return (
      <button onClick={signOut} title={`Sign out — ${user.name}`} className={SIDEBAR_ROW}>
        <SignOutIcon />
        <span className="flex-1 truncate">Sign out</span>
        <span className="text-xs text-zinc-500 truncate max-w-[6rem]">{user.name}</span>
      </button>
    );
  }

  return (
    <button
      onClick={signOut}
      title={`Sign out — ${user.name}`}
      aria-label={`Sign out (${user.name})`}
      className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800
                 rounded px-2 py-1 text-sm transition shrink-0 max-w-[10rem]"
    >
      <span className="truncate">{user.name}</span>
      <SignOutIcon />
    </button>
  );
}

function SignOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.5"
         strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {/* Door + arrow pointing out. */}
      <path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6" />
      <path d="M10 11l3-3-3-3M13 8H6" />
    </svg>
  );
}
