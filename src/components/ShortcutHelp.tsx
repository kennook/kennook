'use client';

import { useEffect, useState } from 'react';
import { SHORTCUTS, formatKey, getBindings, type ShortcutCategory } from '@/lib/shortcuts';
import { ShortcutEditor } from '@/components/ShortcutEditor';

const CATEGORY_ORDER: ShortcutCategory[] = ['navigation', 'viewer', 'video', 'global'];
const CATEGORY_LABEL: Record<ShortcutCategory, string> = {
  navigation: 'Navigation',
  viewer: 'Viewer',
  video: 'Video playback',
  global: 'Global',
};

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'list' | 'user' | 'device';

export function ShortcutHelp({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('list');
  useEffect(() => {
    if (!open) return;
    // While editing, `?`/Esc are captured by the editor's key-capture / inputs,
    // so only close on Esc from the plain list view.
    const onKey = (e: KeyboardEvent) => {
      if (tab === 'list' && (e.key === 'Escape' || e.key === '?')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, tab]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-2xl
                   max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-zinc-900 border-b border-zinc-800 px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1">
            {([['list', 'Shortcuts'], ['user', 'My account'], ['device', 'This device']] as const).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-sm px-2.5 py-1 rounded-md transition ${
                  tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 text-xl leading-none w-8 h-8
                       flex items-center justify-center rounded hover:bg-zinc-800 shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {tab === 'user' && (
          <div className="px-6 py-5">
            <p className="text-xs text-zinc-500 mb-4">
              Rebind or disable a shortcut for <strong>your account</strong> (synced to all your
              devices). Lock one to keep your own devices from overriding it. Shortcuts your admin
              locked show as read-only.
            </p>
            <ShortcutEditor scope="user" />
          </div>
        )}
        {tab === 'device' && (
          <div className="px-6 py-5">
            <p className="text-xs text-zinc-500 mb-4">
              Overrides for <strong>this browser only</strong> — the most specific level, so these
              win unless your account or admin locked the shortcut.
            </p>
            <ShortcutEditor scope="device" />
          </div>
        )}

        <div className={tab === 'list' ? 'px-6 py-5 space-y-6' : 'hidden'}>
          {CATEGORY_ORDER.map((cat) => {
            const inCat = SHORTCUTS.filter((s) => s.category === cat);
            if (!inCat.length) return null;
            return (
              <section key={cat}>
                <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
                  {CATEGORY_LABEL[cat]}
                </h3>
                <div className="space-y-1.5">
                  {inCat.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-start justify-between gap-4 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-100">{s.label}</div>
                        {s.description && (
                          <div className="text-xs text-zinc-500 mt-0.5">{s.description}</div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1 justify-end shrink-0">
                        {getBindings(s.id).map((k, i) => (
                          <Kbd key={`${s.id}-${i}`}>{formatKey(k)}</Kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          <div className="text-xs text-zinc-500 pt-4 border-t border-zinc-800">
            Keys shown are what actually fires (after any admin, account, or device
            overrides). Customize them under <strong>My account</strong> or{' '}
            <strong>This device</strong> above.
          </div>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="px-2 py-0.5 text-xs font-mono bg-zinc-800 border border-zinc-700
                 text-zinc-200 rounded shadow-sm"
    >
      {children}
    </kbd>
  );
}
