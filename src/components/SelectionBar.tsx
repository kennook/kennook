'use client';

import { useState, useRef, useEffect } from 'react';
import { trpc } from '@/lib/trpc-client';

interface SelectionRef {
  librarySlug: string;
  itemUuid: string;
}

interface Props {
  selection: SelectionRef[];
  onClear: () => void;
  /** Active playlist UUID — enables the "Remove from this playlist" action. */
  currentPlaylistUuid?: string | null;
  /** Active playlist name, for the menu label. */
  currentPlaylistName?: string | null;
  /** Called after a remove-from-playlist mutation succeeds. */
  onRemovedFromPlaylist?: () => void;
  /** Active person UUID — enables the "Reassign person…" action. */
  currentPersonUuid?: string | null;
  /** Triggered when the user clicks "Reassign person…". Parent owns the
   *  dialog so it can mount above this bar. */
  onReassignSelection?: () => void;
  /** Triggered when the user clicks "Move to library…". Parent owns the dialog. */
  onMoveSelection?: () => void;
}

export function SelectionBar({
  selection,
  onClear,
  currentPlaylistUuid,
  currentPlaylistName,
  onRemovedFromPlaylist,
  currentPersonUuid,
  onReassignSelection,
  onMoveSelection,
}: Props) {
  if (selection.length === 0) return null;

  return (
    <div
      className="sticky top-[4.4rem] z-20 -mt-6 mb-4 bg-zinc-900/95 backdrop-blur
                 border border-zinc-800 rounded-lg px-4 py-2.5
                 flex items-center gap-3 shadow-lg"
    >
      <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
      <span className="text-sm text-zinc-200">
        {selection.length} selected
      </span>

      <div className="flex-1" />

      <ActionsMenu
        selection={selection}
        onClear={onClear}
        currentPlaylistUuid={currentPlaylistUuid}
        currentPlaylistName={currentPlaylistName}
        onRemovedFromPlaylist={onRemovedFromPlaylist}
        currentPersonUuid={currentPersonUuid}
        onReassignSelection={onReassignSelection}
        onMoveSelection={onMoveSelection}
      />

      <button
        onClick={onClear}
        className="text-sm text-zinc-400 hover:text-zinc-100 px-2 transition"
      >
        Clear
      </button>
    </div>
  );
}

// ─── Actions menu ─────────────────────────────────────────────────────────

function ActionsMenu({
  selection,
  onClear,
  currentPlaylistUuid,
  currentPlaylistName,
  onRemovedFromPlaylist,
  currentPersonUuid,
  onReassignSelection,
  onMoveSelection,
}: {
  selection: SelectionRef[];
  onClear: () => void;
  currentPlaylistUuid?: string | null;
  currentPlaylistName?: string | null;
  onRemovedFromPlaylist?: () => void;
  currentPersonUuid?: string | null;
  onReassignSelection?: () => void;
  onMoveSelection?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const playlists = trpc.playlist.list.useQuery(undefined, { enabled: open });
  const utils = trpc.useUtils();

  // Each action closes the menu immediately at the call site (setOpen(false))
  // and clears the selection once it lands — so items don't stay selected after
  // an action runs. The clear happens in onSuccess (not on click) so it fires
  // AFTER the cache invalidations, since clearing unmounts the whole bar.
  const addItems = trpc.playlist.addItems.useMutation({
    onSuccess: () => { utils.playlist.list.invalidate(); onClear(); },
  });

  const createAndAdd = trpc.playlist.create.useMutation({
    onSuccess: (playlist) => {
      utils.playlist.list.invalidate();
      // Selection is still intact here — it's cleared in addItems.onSuccess.
      addItems.mutate({
        playlistUuid: playlist.uuid,
        items: selection.map((s) => ({ librarySlug: s.librarySlug, itemUuid: s.itemUuid })),
      });
      setCreating(false);
      setNewName('');
    },
  });

  const removeFromCurrent = trpc.playlist.removeItems.useMutation({
    onSuccess: () => {
      utils.playlist.list.invalidate();
      utils.playlist.get.invalidate();
      onRemovedFromPlaylist?.(); // clears the selection in the parent
    },
  });

  const markSensitive = trpc.media.setSensitiveBulk.useMutation({
    onSuccess: () => {
      // Marking can drop items out of a sensitivity-filtered view + flips badges.
      utils.media.list.invalidate();
      utils.media.search.invalidate();
      utils.media.similar.invalidate();
      utils.media.facets.invalidate();
      onClear();
    },
  });

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleRemoveFromPlaylist = () => {
    if (!currentPlaylistUuid) return;
    setOpen(false);
    removeFromCurrent.mutate({
      playlistUuid: currentPlaylistUuid,
      items: selection.map((s) => ({ librarySlug: s.librarySlug, itemUuid: s.itemUuid })),
    });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="bg-zinc-100 hover:bg-white text-zinc-900 rounded-md
                   px-3 py-1.5 text-sm font-medium transition flex items-center gap-1.5"
      >
        Actions
        <Chevron />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-zinc-900 border border-zinc-800
                        rounded-lg shadow-xl py-1 z-20 max-h-[28rem] overflow-y-auto">
          {/* ── Contextual destructive action: remove from current playlist ── */}
          {currentPlaylistUuid && (
            <>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                Current playlist
              </div>
              <button
                onClick={handleRemoveFromPlaylist}
                disabled={removeFromCurrent.isPending}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5
                           text-rose-400 hover:bg-rose-950/40 hover:text-rose-300
                           disabled:opacity-50"
              >
                <MinusIcon />
                <div className="flex-1 min-w-0">
                  <div>Remove from “{currentPlaylistName ?? 'this playlist'}”</div>
                  <div className="text-xs text-zinc-500">
                    {selection.length} item{selection.length === 1 ? '' : 's'}
                  </div>
                </div>
              </button>
              <div className="border-t border-zinc-800 my-1" />
            </>
          )}

          {/* ── Person-filter contextual action: reassign these items to a
              different person (or split / unassign). The dialog itself
              lives on the page so it can mount above this dropdown. ── */}
          {currentPersonUuid && onReassignSelection && (
            <>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                Current person
              </div>
              <button
                onClick={() => { setOpen(false); onReassignSelection(); }}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5
                           text-zinc-200 hover:bg-zinc-800"
              >
                <ReassignIcon />
                <div className="flex-1 min-w-0">
                  <div>Reassign person…</div>
                  <div className="text-xs text-zinc-500">
                    {selection.length} item{selection.length === 1 ? '' : 's'}
                  </div>
                </div>
              </button>
              <div className="border-t border-zinc-800 my-1" />
            </>
          )}

          {/* ── Move to a different library ─────────────────────────────── */}
          {onMoveSelection && (
            <>
              <button
                onClick={() => { setOpen(false); onMoveSelection(); }}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5
                           text-zinc-200 hover:bg-zinc-800"
              >
                <MoveIcon />
                <div className="flex-1 min-w-0">
                  <div>Move to library…</div>
                  <div className="text-xs text-zinc-500">
                    {selection.length} item{selection.length === 1 ? '' : 's'}
                  </div>
                </div>
              </button>
              <div className="border-t border-zinc-800 my-1" />
            </>
          )}

          {/* ── Mark selected as sensitive ──────────────────────────────── */}
          <button
            onClick={() => {
              setOpen(false);
              markSensitive.mutate({
                items: selection.map((s) => ({ librarySlug: s.librarySlug, itemUuid: s.itemUuid })),
                override: 1,
              });
            }}
            disabled={markSensitive.isPending}
            className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5
                       text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            <FlagIcon />
            <div className="flex-1 min-w-0">
              <div>Mark as sensitive</div>
              <div className="text-xs text-zinc-500">
                {selection.length} item{selection.length === 1 ? '' : 's'}
              </div>
            </div>
          </button>
          <div className="border-t border-zinc-800 my-1" />

          {/* ── Add to playlist section ────────────────────────────────── */}
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            Add {selection.length} to…
          </div>

          {playlists.data?.length === 0 && !creating && (
            <div className="px-3 py-3 text-sm text-zinc-500 text-center">
              No playlists yet. Create one below.
            </div>
          )}

          {playlists.data?.map((p) => (
            <button
              key={p.uuid}
              onClick={() => {
                setOpen(false);
                addItems.mutate({
                  playlistUuid: p.uuid,
                  items: selection.map((s) => ({
                    librarySlug: s.librarySlug,
                    itemUuid: s.itemUuid,
                  })),
                });
              }}
              disabled={addItems.isPending}
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

          <div className="border-t border-zinc-800 my-1" />

          {!creating ? (
            <button
              onClick={() => setCreating(true)}
              className="w-full text-left px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800
                         hover:text-zinc-100 flex items-center gap-2"
            >
              <PlusIcon /> New playlist…
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!newName.trim()) return;
                setOpen(false);
                createAndAdd.mutate({ name: newName.trim() });
              }}
              className="px-3 py-2"
            >
              <input
                autoFocus
                type="text"
                placeholder="Playlist name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm
                           focus:border-zinc-600 outline-none"
              />
              <div className="flex gap-2 mt-2">
                <button
                  type="submit"
                  disabled={createAndAdd.isPending || addItems.isPending || !newName.trim()}
                  className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-sm rounded py-1"
                >
                  {createAndAdd.isPending || addItems.isPending ? 'Creating…' : 'Create + Add'}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName(''); }}
                  className="text-sm px-2 text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10">
      <path d="M1 3 L5 7 L9 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 2v8M2 6h8" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7h8" strokeLinecap="round" />
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

function MoveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6" />
      <path d="M9 9.5h5M12 7.5l2 2-2 2" />
      <path d="M2 4.5v7A1.5 1.5 0 0 0 3.5 13H7" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 14V2.5M3.5 3h7l-1.2 2.4L10.5 8h-7" />
    </svg>
  );
}

function ReassignIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="5" r="2.2" />
      <path d="M2 13c0-1.8 1.3-3 3-3" />
      <circle cx="11" cy="11" r="2.2" />
      <path d="M9.5 4.5l3-3M12.5 1.5l1 1M12.5 1.5h-2" />
    </svg>
  );
}
