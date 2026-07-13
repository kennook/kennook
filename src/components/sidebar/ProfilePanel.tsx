'use client';

import { useCurrentUser } from '@/lib/current-user';

/**
 * Level-2 "Profile" panel — account summary + account actions. Theme + Settings
 * are placeholders for now (wired to nothing yet); Logout ends the session.
 */
export function ProfilePanel() {
  const { user } = useCurrentUser();

  const signOut = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* redirect anyway */ }
    window.location.href = '/login';
  };

  return (
    <div className="flex flex-col">
      <PanelHeader title="Profile" />

      <div className="flex items-center gap-3 px-3 py-3">
        <div className="grid place-items-center w-10 h-10 rounded-full bg-zinc-800 text-zinc-200 font-medium">
          {(user?.name ?? '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-zinc-100 truncate">{user?.name ?? 'Signed out'}</div>
          <div className="text-xs text-zinc-500">My account</div>
        </div>
      </div>

      <div className="border-t border-zinc-800/70 my-1 mx-3" />

      <Row icon={<UserIcon />} label="My account" hint="Coming soon" disabled />
      <Row icon={<ThemeIcon />} label="Light / Dark mode" hint="Coming soon" disabled />
      <Row icon={<SettingsIcon />} label="Settings" hint="Coming soon" disabled />

      <div className="border-t border-zinc-800/70 my-1 mx-3" />

      {user && (
        <button
          onClick={signOut}
          className="flex items-center gap-2.5 px-3 mx-1 py-2 rounded-md text-sm text-left
                     text-red-300 hover:bg-red-950/40 hover:text-red-200 transition"
        >
          <span className="grid place-items-center w-5 shrink-0"><LogoutIcon /></span>
          <span className="flex-1">Log out</span>
          <span className="text-xs text-zinc-500 truncate max-w-[7rem]">{user.name}</span>
        </button>
      )}
    </div>
  );
}

function Row({ icon, label, hint, disabled }: {
  icon: React.ReactNode; label: string; hint?: string; disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      className={`flex items-center gap-2.5 px-3 mx-1 py-2 rounded-md text-sm text-left transition
                  ${disabled ? 'text-zinc-500 cursor-default' : 'text-zinc-300 hover:bg-zinc-900'}`}
    >
      <span className="grid place-items-center w-5 shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[10px] uppercase tracking-wider text-zinc-600">{hint}</span>}
    </button>
  );
}

export function PanelHeader({ title }: { title: string }) {
  return (
    <div className="px-3 pt-1 pb-2">
      <h2 className="text-sm font-medium text-zinc-100">{title}</h2>
    </div>
  );
}

function UserIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" strokeLinecap="round" />
  </svg>
); }
function ThemeIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <circle cx="12" cy="12" r="5" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" strokeLinecap="round" />
  </svg>
); }
function SettingsIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" strokeLinecap="round" />
  </svg>
); }
function LogoutIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" />
  </svg>
); }
