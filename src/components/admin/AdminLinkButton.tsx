'use client';

/**
 * Tiny header icon button that links to /admin. Visible ONLY when the
 * current user is signed in as an admin — non-admins never see it.
 *
 * Placed next to the `?` help button in the main app header.
 */

import Link from 'next/link';
import { useIsAdmin } from '@/lib/current-user';

export function AdminLinkButton() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return null;

  return (
    <Link
      href="/admin"
      title="Admin"
      aria-label="Admin"
      className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800
                 rounded p-1.5 transition shrink-0 flex items-center justify-center"
    >
      <WrenchIcon />
    </Link>
  );
}

function WrenchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.5"
         strokeLinecap="round" strokeLinejoin="round">
      {/* Simple gear: outer ring with 8 teeth + inner circle. */}
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2
               M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4
               M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  );
}
