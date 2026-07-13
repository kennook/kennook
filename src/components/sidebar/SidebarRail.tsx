'use client';

import { useState } from 'react';
import Link from 'next/link';
import { KenNookLogo } from '@/components/KenNookLogo';
import { ConnectModal } from '@/components/ConnectDeviceButton';
import { useIsAdmin } from '@/lib/current-user';

export type RailSection = 'saved' | 'playlists' | 'library' | 'sources' | 'profile';

interface Props {
  active: RailSection | null;
  onSelect: (s: RailSection) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  hasSaved: boolean;
  hasPlaylists: boolean;
  onOpenHelp: () => void;
}

/**
 * Level-1 sidebar rail — the thin, always-present navigation column. Collapsible
 * between icon-only and icon + label (remembered by the parent). Selecting a
 * section (saved / playlists / library / sources / profile) shows its content in
 * the wide Level-2 panel; the bottom group holds one-off actions (connect a
 * device, keyboard shortcuts, admin).
 */
export function SidebarRail({
  active, onSelect, collapsed, onToggleCollapsed, hasSaved, hasPlaylists, onOpenHelp,
}: Props) {
  const isAdmin = useIsAdmin();
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <nav className={`kn-app-scaled flex flex-col ${collapsed ? 'w-14' : 'w-52'} shrink-0
                     transition-[width] duration-200`}>
      <div className="flex items-center px-2 h-10 mb-3">
        {collapsed ? (
          <span className="mx-auto grid place-items-center w-8 h-8 rounded-lg bg-zinc-100 text-zinc-900 font-bold text-sm">
            K
          </span>
        ) : (
          <span className="px-1"><KenNookLogo height={22} /></span>
        )}
      </div>

      {/* Top: navigation sections. */}
      <div className="flex flex-col gap-0.5 px-1.5">
        {hasSaved && (
          <RailItem icon={<SavedIcon />} label="Saved searches" collapsed={collapsed}
            active={active === 'saved'} onClick={() => onSelect('saved')} />
        )}
        {hasPlaylists && (
          <RailItem icon={<PlaylistIcon />} label="Playlists" collapsed={collapsed}
            active={active === 'playlists'} onClick={() => onSelect('playlists')} />
        )}
        <RailItem icon={<LibraryIcon />} label="Library" collapsed={collapsed}
          active={active === 'library'} onClick={() => onSelect('library')} />
        <RailItem icon={<SourcesIcon />} label="External sources" collapsed={collapsed}
          active={active === 'sources'} onClick={() => onSelect('sources')} />
      </div>

      <div className="flex-1" />

      {/* Bottom: one-off actions + profile. */}
      <div className="flex flex-col gap-0.5 px-1.5 pb-1">
        <RailItem icon={<ConnectIcon />} label="Connect a device" collapsed={collapsed}
          onClick={() => setConnectOpen(true)} />
        <RailItem icon={<ShortcutsIcon />} label="Keyboard shortcuts" collapsed={collapsed}
          onClick={onOpenHelp} />
        {isAdmin && (
          <RailItem icon={<AdminIcon />} label="Admin" collapsed={collapsed} href="/admin" />
        )}
        <RailItem icon={<ProfileIcon />} label="Profile" collapsed={collapsed}
          active={active === 'profile'} onClick={() => onSelect('profile')} />
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="mt-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-zinc-600
                     hover:text-zinc-200 hover:bg-zinc-900 transition"
        >
          <span className={`grid place-items-center w-5 shrink-0 transition-transform ${collapsed ? '' : 'rotate-180'}`}>
            <ChevronsIcon />
          </span>
          {!collapsed && <span className="flex-1 text-left">Collapse</span>}
        </button>
      </div>

      {connectOpen && <ConnectModal onClose={() => setConnectOpen(false)} />}
    </nav>
  );
}

function RailItem({
  icon, label, collapsed, active, onClick, href,
}: {
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  active?: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const cls = `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition
               ${active
                 ? 'bg-zinc-800 text-zinc-100'
                 : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'}
               ${collapsed ? 'justify-center' : ''}`;
  const inner = (
    <>
      <span className="grid place-items-center w-5 shrink-0">{icon}</span>
      {!collapsed && <span className="flex-1 truncate text-left">{label}</span>}
    </>
  );
  if (href) return <Link href={href} title={label} className={cls}>{inner}</Link>;
  return <button onClick={onClick} title={label} className={cls}>{inner}</button>;
}

// ── Icons ──
function SavedIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" strokeLinecap="round" />
  </svg>
); }
function PlaylistIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
    <path d="M4 7h11M4 12h11M4 17h7" /><path d="M18 12v6" /><circle cx="18" cy="18" r="2" fill="currentColor" stroke="none" />
  </svg>
); }
function LibraryIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
); }
function SourcesIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" className="text-red-500" aria-hidden>
    <path fill="currentColor" d="M23 12s0-3.8-.5-5.6a2.9 2.9 0 0 0-2-2C18.7 4 12 4 12 4s-6.7 0-8.5.4a2.9 2.9 0 0 0-2 2C1 8.2 1 12 1 12s0 3.8.5 5.6a2.9 2.9 0 0 0 2 2C5.3 20 12 20 12 20s6.7 0 8.5-.4a2.9 2.9 0 0 0 2-2C23 15.8 23 12 23 12z" />
    <path fill="#fff" d="M10 15.5v-7l6 3.5z" />
  </svg>
); }
function ConnectIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" strokeLinecap="round" />
  </svg>
); }
function ShortcutsIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M12 11v5" strokeLinecap="round" /><circle cx="12" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
); }
function AdminIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.7-.7-2.5z" />
  </svg>
); }
function ProfileIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" strokeLinecap="round" />
  </svg>
); }
function ChevronsIcon() { return (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13 6l6 6-6 6M5 6l6 6-6 6" />
  </svg>
); }
