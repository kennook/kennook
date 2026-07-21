'use client';

import { useCurrentUser } from '@/lib/current-user';
import { trpc } from '@/lib/trpc-client';
import {
  ACTION_LABELS, HOT_CORNER_ACTIONS, DEFAULT_HOT_CORNERS,
  type Corner, type HotCornerAction, type HotCornerMap,
} from '@/lib/hot-corner';

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

      <div className="border-t border-zinc-800/70 my-1 mx-3" />

      <HotCornersSettings />

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

const CORNER_ORDER: Corner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

function HotCornersSettings() {
  const utils = trpc.useUtils();
  const q = trpc.hotCorners.get.useQuery();
  const set = trpc.hotCorners.set.useMutation({
    onMutate: async (next) => {
      await utils.hotCorners.get.cancel();
      const prev = utils.hotCorners.get.getData();
      utils.hotCorners.get.setData(undefined, next as HotCornerMap);
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.hotCorners.get.setData(undefined, ctx.prev); },
    onSettled: () => utils.hotCorners.get.invalidate(),
  });

  const map = q.data ?? DEFAULT_HOT_CORNERS;
  const update = (corner: Corner, action: HotCornerAction) => set.mutate({ ...map, [corner]: action });

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2.5 mb-1">
        <span className="grid place-items-center w-5 shrink-0 text-zinc-400"><CornersIcon /></span>
        <span className="text-sm text-zinc-300 flex-1">Hot corners</span>
      </div>
      <p className="text-[11px] text-zinc-500 ml-[1.9rem] mb-2 leading-relaxed">
        Fling the cursor into a screen corner to run an action. Synced to your account.
      </p>
      {/* 2×2 grid mirroring the screen corners. */}
      <div className="ml-[1.9rem] grid grid-cols-2 gap-1.5">
        {CORNER_ORDER.map((corner) => (
          <label key={corner} className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-600">{CORNER_TITLE[corner]}</span>
            <select
              value={map[corner]}
              onChange={(e) => update(corner, e.target.value as HotCornerAction)}
              className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200
                         outline-none focus:border-zinc-500"
            >
              {HOT_CORNER_ACTIONS.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a]}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

const CORNER_TITLE: Record<Corner, string> = {
  topLeft: '↖ Top-left', topRight: '↗ Top-right', bottomLeft: '↙ Bottom-left', bottomRight: '↘ Bottom-right',
};

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
function CornersIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 8V4h4M17 3h4v4M21 16v4h-4M7 21H3v-4" />
  </svg>
); }
function LogoutIcon() { return (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" />
  </svg>
); }
