'use client';

/**
 * Sidebar nav for the /admin section. Static for now — when a new
 * subsection lands, add an entry to NAV_ITEMS below and create the
 * corresponding `src/app/admin/<slug>/page.tsx`.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  label: string;
  href: string;
  // Future: optional icon, badge counter, role-within-admin gating.
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Indexing',      href: '/admin/indexing' },
  { label: 'Feature flags', href: '/admin/flags' },
  { label: 'Settings',      href: '/admin/settings' },
  { label: 'Users',         href: '/admin/users' },
  { label: 'Theme',         href: '/admin/theme' },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-zinc-900 bg-zinc-950
                      sticky top-0 self-start h-screen flex flex-col">
      <div className="px-5 py-5 border-b border-zinc-900">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          Kennook
        </div>
        <div className="text-base font-medium text-zinc-100 mt-0.5">
          Admin
        </div>
      </div>

      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          // Match exact OR sub-routes (e.g. /admin/indexing/runs/123 still
          // highlights "Indexing"). Strip trailing segments by comparing
          // the start of the path.
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block px-3 py-2 rounded text-sm transition
                          ${active
                            ? 'bg-zinc-800 text-zinc-100'
                            : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-2 py-3 border-t border-zinc-900">
        <Link
          href="/"
          className="block px-3 py-2 rounded text-sm text-zinc-500
                     hover:bg-zinc-900 hover:text-zinc-200 transition"
        >
          ← Back to Kennook
        </Link>
      </div>
    </aside>
  );
}
