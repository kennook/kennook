'use client';

/**
 * Reusable shortcut-override editor for one tier. Same component powers all three
 * levels:
 *   - scope="tenant"  — admin, instance-wide (trpc.shortcuts.setTenant).
 *   - scope="user"    — this account, synced (trpc.shortcuts.setUser).
 *   - scope="device"  — this browser (localStorage via setBinding).
 * Per shortcut: rebind (key capture), disable (empty keys), reset (clear this
 * tier's override), and — for tenant/user — a lock that blocks every tier below.
 * Rows a HIGHER tier already locked are shown read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import {
  SHORTCUTS,
  formatKey,
  eventToBinding,
  resolveBinding,
  getDeviceBindings,
  setBinding,
  setTenantOverrides,
  setUserOverrides,
  useBindingsVersion,
  type ShortcutCategory,
  type ShortcutOverrideMap,
} from '@/lib/shortcuts';

const CATEGORY_ORDER: ShortcutCategory[] = ['navigation', 'viewer', 'video', 'global'];
const CATEGORY_LABEL: Record<ShortcutCategory, string> = {
  navigation: 'Navigation',
  viewer: 'Viewer',
  video: 'Video playback',
  global: 'Global',
};

type Scope = 'tenant' | 'user' | 'device';

export function ShortcutEditor({ scope }: { scope: Scope }) {
  const version = useBindingsVersion(); // re-read device tier + resolveBinding live
  const utils = trpc.useUtils();

  const tenantQ = trpc.shortcuts.getTenant.useQuery(undefined, { enabled: scope === 'tenant', staleTime: 60_000 });
  const userQ = trpc.shortcuts.getUser.useQuery(undefined, { enabled: scope === 'user', staleTime: 60_000 });

  const setTenant = trpc.shortcuts.setTenant.useMutation({
    onMutate: (next) => { setTenantOverrides(next); utils.shortcuts.getTenant.setData(undefined, next); },
    onSettled: () => utils.shortcuts.getTenant.invalidate(),
  });
  const setUser = trpc.shortcuts.setUser.useMutation({
    onMutate: (next) => { setUserOverrides(next); utils.shortcuts.getUser.setData(undefined, next); },
    onSettled: () => utils.shortcuts.getUser.invalidate(),
  });

  // This tier's own override map (device tier is localStorage; re-read on version).
  const ownMap: ShortcutOverrideMap = useMemo(() =>
    scope === 'tenant' ? (tenantQ.data ?? {})
    : scope === 'user' ? (userQ.data ?? {})
    : Object.fromEntries(Object.entries(getDeviceBindings()).map(([id, keys]) => [id, { keys }])),
    // `version` refreshes the localStorage read for the device tier.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, tenantQ.data, userQ.data, version]);

  const write = useCallback((next: ShortcutOverrideMap) => {
    if (scope === 'tenant') setTenant.mutate(next);
    else if (scope === 'user') setUser.mutate(next);
  }, [scope, setTenant, setUser]);

  // Set (or, with null, clear) this tier's keys for a shortcut, preserving a lock.
  const setKeys = useCallback((id: string, keys: string[] | null) => {
    if (scope === 'device') { setBinding(id, keys); return; }
    const next: ShortcutOverrideMap = { ...ownMap };
    const cur = next[id] ?? {};
    if (keys === null) {
      const merged = { ...cur }; delete merged.keys;
      if (merged.locked === undefined) delete next[id]; else next[id] = merged;
    } else {
      next[id] = { ...cur, keys };
    }
    write(next);
  }, [scope, ownMap, write]);

  const toggleLock = useCallback((id: string) => {
    if (scope === 'device') return;
    const next: ShortcutOverrideMap = { ...ownMap };
    const cur = next[id] ?? {};
    if (cur.locked) {
      const merged = { ...cur }; delete merged.locked;
      if (merged.keys === undefined) delete next[id]; else next[id] = merged;
    } else {
      next[id] = { ...cur, locked: true };
    }
    write(next);
  }, [scope, ownMap, write]);

  // Key-capture: click Rebind → next keypress becomes the (single) binding.
  const [capturing, setCapturing] = useState<string | null>(null);
  const setKeysRef = useRef(setKeys); setKeysRef.current = setKeys;
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const b = eventToBinding(e);
      if (!b) return; // modifier-only — keep waiting
      setKeysRef.current(capturing, [b]);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing]);

  const saving = setTenant.isPending || setUser.isPending;

  return (
    <div className="space-y-6">
      {CATEGORY_ORDER.map((cat) => {
        const inCat = SHORTCUTS.filter((s) => s.category === cat);
        if (!inCat.length) return null;
        return (
          <section key={cat}>
            <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">{CATEGORY_LABEL[cat]}</h3>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800/70">
              {inCat.map((s) => {
                const own = ownMap[s.id];
                // Effective binding + who (if anyone) locked it from above.
                const resolved = scope === 'tenant'
                  ? { keys: own?.keys ?? s.defaultKeys, lockedBy: null as 'tenant' | 'user' | null }
                  : resolveBinding(s.id);
                const lockedAbove = scope === 'user'
                  ? resolved.lockedBy === 'tenant'
                  : scope === 'device' ? resolved.lockedBy !== null : false;
                const isCapturing = capturing === s.id;
                const keys = resolved.keys;

                return (
                  <div key={s.id} className="flex items-start justify-between gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-zinc-100 flex items-center gap-2">
                        {s.label}
                        {own && !lockedAbove && (
                          <span className="text-[10px] uppercase tracking-wide text-emerald-400/80">set here</span>
                        )}
                        {own?.locked && scope !== 'device' && (
                          <span className="text-[10px] uppercase tracking-wide text-amber-400/90">locked</span>
                        )}
                      </div>
                      {s.description && <div className="text-xs text-zinc-500 mt-0.5">{s.description}</div>}
                      {lockedAbove && (
                        <div className="text-[11px] text-amber-400/80 mt-1">
                          Locked by {resolved.lockedBy} — can’t change here.
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <div className="flex flex-wrap gap-1 justify-end">
                        {isCapturing ? (
                          <span className="text-xs text-emerald-300 animate-pulse">Press a key… (Esc to cancel)</span>
                        ) : keys.length === 0 ? (
                          <span className="text-xs text-zinc-500 italic">disabled</span>
                        ) : (
                          keys.map((k, i) => (
                            <kbd key={`${s.id}-${i}`} className="px-2 py-0.5 text-xs font-mono bg-zinc-800 border border-zinc-700 text-zinc-200 rounded">
                              {formatKey(k)}
                            </kbd>
                          ))
                        )}
                      </div>

                      {!lockedAbove && (
                        <div className="flex items-center gap-2 text-xs">
                          <button
                            type="button" disabled={saving}
                            onClick={() => setCapturing(isCapturing ? null : s.id)}
                            className="text-zinc-300 hover:text-white disabled:opacity-40"
                          >
                            {isCapturing ? 'Cancel' : 'Rebind'}
                          </button>
                          <button
                            type="button" disabled={saving}
                            onClick={() => setKeys(s.id, [])}
                            className="text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
                          >
                            Disable
                          </button>
                          {own && (
                            <button
                              type="button" disabled={saving}
                              onClick={() => setKeys(s.id, null)}
                              className="text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
                            >
                              Reset
                            </button>
                          )}
                          {scope !== 'device' && (
                            <button
                              type="button" disabled={saving}
                              onClick={() => toggleLock(s.id)}
                              aria-pressed={!!own?.locked}
                              className={`px-1.5 py-0.5 rounded ring-1 disabled:opacity-40 ${
                                own?.locked
                                  ? 'bg-amber-950/60 text-amber-300 ring-amber-800/60'
                                  : 'text-zinc-400 ring-zinc-700 hover:text-zinc-200'
                              }`}
                              title={own?.locked ? 'Locked for lower levels — click to unlock' : 'Lock so lower levels can’t change it'}
                            >
                              {own?.locked ? '🔒 Locked' : 'Lock'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {(setTenant.isError || setUser.isError) && (
        <div className="text-xs text-red-400">Couldn’t save — {scope === 'tenant' ? 'admin access required.' : 'try again.'}</div>
      )}
    </div>
  );
}
