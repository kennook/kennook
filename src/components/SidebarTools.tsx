'use client';

/**
 * Bottom "tools" block of the left sidebar — the low-traffic, non-navigation
 * actions (connect a device, keyboard shortcuts, admin, sign out). Lives under
 * a divider beneath the navigation sections.
 */

import { ConnectDeviceButton } from '@/components/ConnectDeviceButton';
import { AdminLinkButton } from '@/components/admin/AdminLinkButton';
import { SignOutButton } from '@/components/SignOutButton';
import { SIDEBAR_ROW } from '@/components/ui/sidebar-row';

export function SidebarTools({ onOpenHelp }: { onOpenHelp: () => void }) {
  return (
    <div className="mt-6 pt-4 border-t border-zinc-900 flex flex-col">
      <ConnectDeviceButton variant="sidebar" />
      <button onClick={onOpenHelp} title="Keyboard shortcuts (?)" className={SIDEBAR_ROW}>
        <InfoIcon />
        <span className="flex-1">Keyboard shortcuts</span>
      </button>
      <AdminLinkButton variant="sidebar" />
      <SignOutButton variant="sidebar" />
    </div>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.5"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.5v3.5" />
      <circle cx="8" cy="5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
