/**
 * Admin section layout — sidebar nav on the left, content on the right.
 *
 * Access control is server-side: reads the `kennook_user` cookie via
 * `next/headers` and resolves the user. Non-admins are redirected to
 * `/login?returnTo=/admin/...`. Doing this in the layout means EVERY
 * /admin/* page inherits the gate without each page having to repeat
 * the check.
 *
 * Sidebar items are static for now; each subsection is its own page
 * under `src/app/admin/<slug>/page.tsx`. When new sections land,
 * add a row to `NAV_ITEMS` below.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser, isAdmin } from '@/server/auth';
import { AdminSidebar } from '@/components/admin/AdminSidebar';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const cookieHeader = (await headers()).get('cookie');
  const user = getCurrentUser(cookieHeader);
  if (!isAdmin(user)) {
    // Bounce non-admins to the picker. The picker has no concept of
    // "returnTo into admin" yet — they'll land at `/` after picking
    // Admin and have to navigate back. Good enough for Phase 1.
    redirect('/login?returnTo=/admin');
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      <AdminSidebar />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
