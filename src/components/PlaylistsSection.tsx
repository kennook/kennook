'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

interface Props {
  activePlaylistUuid: string | null;
  onSelectPlaylist: (uuid: string | null) => void;
}

/**
 * Sidebar Playlists picker — a compact dropdown (was a full list) so a long
 * playlist collection doesn't dominate the sidebar. Cross-library: the same
 * list shows regardless of which library is active.
 */
export function PlaylistsSection({ activePlaylistUuid, onSelectPlaylist }: Props) {
  const playlists = trpc.playlist.list.useQuery();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Hidden until there's something to show — creating a playlist is a
  // discoverable action (select items → "Add to playlist"), not a hint that
  // needs permanent sidebar space.
  if (!playlists.data || playlists.data.length === 0) return null;

  const active = playlists.data.find((p) => p.uuid === activePlaylistUuid) ?? null;

  const pick = (uuid: string | null) => {
    onSelectPlaylist(uuid);
    setOpen(false);
  };

  return (
    <section className="mb-5">
      <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 px-3 mb-1.5">
        Playlists
      </h3>

      <div className="relative px-1" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition
                      border ${active
                        ? 'bg-zinc-800/80 text-zinc-100 border-zinc-700'
                        : 'bg-zinc-900/60 text-zinc-300 border-zinc-800 hover:border-zinc-700'}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
          <span className="flex-1 truncate text-left">{active ? active.name : 'All playlists'}</span>
          {active && (
            <span className="text-xs text-zinc-500 tabular-nums shrink-0">{active.itemCount}</span>
          )}
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-500 shrink-0">
            <path d="M1 3 L5 7 L9 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>

        {open && (
          <div className="absolute left-1 right-1 top-full mt-1 z-20 max-h-72 overflow-y-auto
                          bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1">
            <button
              onClick={() => pick(null)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-800
                          ${active ? 'text-zinc-400' : 'text-zinc-100'}`}
            >
              All playlists
            </button>
            <div className="border-t border-zinc-800 my-1" />
            {playlists.data.map((p) => {
              const isCurrent = p.uuid === activePlaylistUuid;
              return (
                <button
                  key={p.uuid}
                  onClick={() => pick(isCurrent ? null : p.uuid)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 hover:bg-zinc-800
                              ${isCurrent ? 'text-zinc-100' : 'text-zinc-300'}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isCurrent ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="text-xs text-zinc-500 tabular-nums shrink-0">{p.itemCount}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
