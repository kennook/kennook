'use client';

import { trpc } from '@/lib/trpc-client';

interface Props {
  activePlaylistUuid: string | null;
  onSelectPlaylist: (uuid: string | null) => void;
}

/**
 * Sidebar section listing all playlists. Cross-library — same list shown
 * regardless of which library is active.
 */
export function PlaylistsSection({ activePlaylistUuid, onSelectPlaylist }: Props) {
  const playlists = trpc.playlist.list.useQuery();

  // Hidden until there's something to show — creating a playlist is a
  // discoverable action (select items → "Add to playlist"), not a hint that
  // needs permanent sidebar space.
  if (!playlists.data || playlists.data.length === 0) return null;

  return (
    <section className="mb-5">
      <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 px-3 mb-1.5
                     flex items-center justify-between">
        <span>Playlists</span>
        {activePlaylistUuid && (
          <button
            onClick={() => onSelectPlaylist(null)}
            className="text-zinc-500 hover:text-zinc-300 normal-case tracking-normal
                       text-xs lowercase"
          >
            exit
          </button>
        )}
      </h3>

      <div className="flex flex-col">
        {playlists.data?.map((p) => {
          const active = p.uuid === activePlaylistUuid;
          return (
            <button
              key={p.uuid}
              onClick={() => onSelectPlaylist(active ? null : p.uuid)}
              className={`w-full text-left px-3 py-1.5 rounded text-sm flex items-center gap-2.5
                          transition
                          ${active
                            ? 'bg-zinc-800/80 text-zinc-100'
                            : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60'}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors
                            ${active ? 'bg-emerald-400' : 'bg-zinc-700'}`}
              />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="text-xs text-zinc-500 tabular-nums shrink-0">
                {p.itemCount}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
