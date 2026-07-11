'use client';

/**
 * The right "utilities" aside — mirror of the left facets sidebar. Holds
 * everything that isn't core to navigating/viewing the library, so the header
 * and grid stay dedicated to browsing: library switcher, connect-a-device,
 * keyboard shortcuts, admin, sign out.
 *
 * Collapsible + persisted like the left sidebar; the toggle lives in the header.
 */

import { trpc } from '@/lib/trpc-client';
import { LibrarySwitcher } from '@/components/LibrarySwitcher';
import { ConnectDeviceButton } from '@/components/ConnectDeviceButton';
import { AdminLinkButton } from '@/components/admin/AdminLinkButton';
import { SignOutButton } from '@/components/SignOutButton';
import { SIDEBAR_ROW } from '@/components/ui/sidebar-row';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 px-3 mb-1.5">
      {children}
    </h3>
  );
}

export function RightSidebar({ onOpenHelp }: { onOpenHelp: () => void }) {
  // Only surface the Library section when there's more than one to switch
  // between — otherwise the whole section (label included) is just clutter.
  const libraries = trpc.library.list.useQuery();
  const showLibrary = (libraries.data?.length ?? 0) > 1;

  return (
    <div className="flex flex-col gap-5">
      {showLibrary && (
        <section>
          <SectionLabel>Library</SectionLabel>
          <LibrarySwitcher variant="sidebar" align="left" hideWhenSingle />
        </section>
      )}

      <section>
        <SectionLabel>More</SectionLabel>
        <div className="flex flex-col">
          <ConnectDeviceButton variant="sidebar" />
          <button onClick={onOpenHelp} title="Keyboard shortcuts (?)" className={SIDEBAR_ROW}>
            <InfoIcon />
            <span className="flex-1">Keyboard shortcuts</span>
          </button>
          <AdminLinkButton variant="sidebar" />
          <SignOutButton variant="sidebar" />
        </div>
      </section>
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
