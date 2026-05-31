'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';

interface ItemRef {
  uuid: string;
  librarySlug: string;
  filename?: string;
}

interface Props {
  item: ItemRef;
  onClose: () => void;
  /** Fired after the server confirms the add. Use it to show a toast or
   *  pop the dialog. */
  onAdded?: (info: { playlistUuid: string; playlistName: string; added: number; skipped: number }) => void;
}

/**
 * Modal picker for adding a single asset to a playlist. Mirrors the
 * SelectionBar's multi-add UX (existing list + inline create) but
 * focused on one item so it fits a viewer / details context.
 *
 * No search — playlist counts are usually small enough that scrolling
 * is fine; we can add a filter if libraries get heavy with playlists.
 */
export function AddToPlaylistDialog({ item, onClose, onAdded }: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const playlists = trpc.playlist.list.useQuery();

  const addItems = trpc.playlist.addItems.useMutation({
    onSuccess: (res, vars) => {
      utils.playlist.list.invalidate();
      const name = playlists.data?.find((p) => p.uuid === vars.playlistUuid)?.name ?? 'playlist';
      const msg = res.added > 0
        ? `Added to "${name}"`
        : `Already in "${name}"`;
      setFeedback(msg);
      onAdded?.({
        playlistUuid: vars.playlistUuid,
        playlistName: name,
        added: res.added,
        skipped: res.skipped,
      });
      // Close after a short beat so the feedback is readable.
      setTimeout(onClose, 700);
    },
  });

  const createAndAdd = trpc.playlist.create.useMutation({
    onSuccess: (playlist) => {
      utils.playlist.list.invalidate();
      addItems.mutate({
        playlistUuid: playlist.uuid,
        items: [{ librarySlug: item.librarySlug, itemUuid: item.uuid }],
      });
      setCreating(false);
      setNewName('');
    },
  });

  const submitting = addItems.isPending || createAndAdd.isPending;

  const addTo = (playlistUuid: string) => {
    addItems.mutate({
      playlistUuid,
      items: [{ librarySlug: item.librarySlug, itemUuid: item.uuid }],
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
      />
      <div
        role="dialog"
        aria-label="Add to playlist"
        className="relative bg-zinc-950 border border-zinc-800 rounded-xl w-full
                   max-w-md max-h-[80vh] flex flex-col shadow-2xl"
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-zinc-500">Add to playlist</div>
            <div className="text-sm text-zinc-200 truncate">
              {item.filename ?? item.uuid}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {playlists.isLoading && (
            <div className="px-4 py-3 text-sm text-zinc-500">Loading…</div>
          )}
          {playlists.data?.length === 0 && !creating && (
            <div className="px-4 py-6 text-sm text-zinc-500 text-center">
              No playlists yet. Create one below.
            </div>
          )}
          {playlists.data?.map((p) => (
            <button
              key={p.uuid}
              onClick={() => addTo(p.uuid)}
              disabled={submitting}
              className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5
                         hover:bg-zinc-800 text-zinc-200 disabled:opacity-50"
            >
              {p.coverThumbnailUrl ? (
                <img
                  src={p.coverThumbnailUrl}
                  alt=""
                  className="w-8 h-8 rounded object-cover shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded bg-zinc-800 flex items-center justify-center shrink-0">
                  <PlaylistIcon />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="truncate">{p.name}</div>
                <div className="text-xs text-zinc-500">{p.itemCount} items</div>
              </div>
            </button>
          ))}
        </div>

        <div className="border-t border-zinc-800">
          {!creating ? (
            <button
              onClick={() => setCreating(true)}
              disabled={submitting}
              className="w-full text-left px-4 py-3 text-sm text-zinc-400 hover:bg-zinc-800
                         hover:text-zinc-100 flex items-center gap-2 disabled:opacity-50"
            >
              <PlusIcon /> New playlist…
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newName.trim()) createAndAdd.mutate({ name: newName.trim() });
              }}
              className="px-4 py-3"
            >
              <input
                autoFocus
                type="text"
                placeholder="Playlist name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm
                           focus:border-zinc-600 outline-none"
              />
              <div className="flex gap-2 mt-2">
                <button
                  type="submit"
                  disabled={submitting || !newName.trim()}
                  className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-sm rounded py-1"
                >
                  {submitting ? 'Creating…' : 'Create + Add'}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName(''); }}
                  className="text-sm px-2 text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
              {createAndAdd.error && (
                <div className="mt-2 text-xs text-red-400">
                  {createAndAdd.error.message}
                </div>
              )}
            </form>
          )}
        </div>

        {feedback && (
          <div className="px-4 py-2 text-xs text-emerald-400 border-t border-zinc-800">
            {feedback}
          </div>
        )}
        {addItems.error && (
          <div className="px-4 py-2 text-xs text-red-400 border-t border-zinc-800">
            {addItems.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 2v8M2 6h8" strokeLinecap="round" />
    </svg>
  );
}

function PlaylistIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 5h8M3 8h8M3 11h5" strokeLinecap="round" />
      <circle cx="13" cy="11" r="1.5" fill="currentColor" />
    </svg>
  );
}
