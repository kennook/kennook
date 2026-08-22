'use client';

/**
 * Bookmark panel for the video viewer: an add form (when the player requests a
 * new bookmark at the current time) plus a list of existing bookmarks to jump
 * to or delete. The parent (MediaViewer) owns the `listBookmarks` query so the
 * same data drives the scrubber ticks; this component owns the mutations.
 */

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

export interface Bookmark {
  id: number;
  timestampMs: number;
  label: string;
  visibility: 'shared' | 'private';
  mine: boolean;
}

interface Props {
  uuid: string;
  librarySlug: string;
  bookmarks: Bookmark[];
  defaultShared: boolean;
  isAdmin: boolean;
  /** When non-null, show the "add" form pre-set to this timestamp (ms). */
  addAtMs: number | null;
  onCloseAdd: () => void;
  onSeek: (ms: number) => void;
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

export function VideoBookmarks({
  uuid, librarySlug, bookmarks, defaultShared, isAdmin, addAtMs, onCloseAdd, onSeek,
}: Props) {
  const utils = trpc.useUtils();
  const invalidate = () => utils.media.listBookmarks.invalidate({ uuid, librarySlug });

  const add = trpc.media.addBookmark.useMutation({ onSuccess: () => { invalidate(); onCloseAdd(); } });
  const remove = trpc.media.removeBookmark.useMutation({ onSuccess: invalidate });

  const [label, setLabel] = useState('');
  const [shared, setShared] = useState(defaultShared);

  // Reset the form each time a new add is requested.
  useEffect(() => {
    if (addAtMs != null) { setLabel(''); setShared(defaultShared); }
  }, [addAtMs, defaultShared]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (addAtMs == null || add.isPending) return;
    add.mutate({ uuid, librarySlug, timestampMs: addAtMs, label: label.trim(), shared });
  };

  if (addAtMs == null && bookmarks.length === 0) return null;

  return (
    <div
      data-kn-chrome=""
      // `shrink-0` is load-bearing: this box has `overflow-y-auto`, which per the
      // flexbox spec gives a flex item an automatic minimum size of 0 — so inside
      // the info panel's `flex flex-col` it becomes collapsible. On a short
      // viewport with tall (non-shrinkable) AI-metadata below, the flex algorithm
      // would shrink THIS box toward zero instead of letting the panel scroll,
      // hiding the bookmark add field until you zoomed out. `shrink-0` keeps it at
      // its natural height (capped at 60vh) and the panel scrolls for the rest.
      className="shrink-0 max-h-[60vh] overflow-y-auto text-sm flex flex-col gap-2"
    >
      {addAtMs != null && (
        <form onSubmit={submit} className="flex flex-col gap-2 border-b border-zinc-800 pb-3">
          <div className="text-xs text-zinc-400">
            New bookmark at <span className="text-amber-300 tabular-nums">{fmt(addAtMs)}</span>
          </div>
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCloseAdd(); } }}
            placeholder="Tags — e.g. beach towel, sandcastle"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2.5 py-1.5 text-sm
                       outline-none focus:border-zinc-500"
          />
          <label className="flex items-center gap-2 text-xs text-zinc-400 select-none">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)}
              className="accent-emerald-500" />
            Shared (everyone can see &amp; search it)
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={add.isPending}
              className="bg-zinc-200 text-zinc-900 rounded-md px-3 py-1 text-sm font-medium
                         hover:bg-white disabled:opacity-40 transition">
              {add.isPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={onCloseAdd}
              className="text-zinc-400 hover:text-zinc-200 px-2 py-1 text-sm transition">Cancel</button>
          </div>
        </form>
      )}

      {bookmarks.length > 0 && (
        <div className="flex flex-col">
          {bookmarks.map((b) => (
            <div key={b.id} className="group flex items-center gap-2 py-1">
              <button
                onClick={() => onSeek(b.timestampMs)}
                className="text-amber-300 hover:text-amber-200 tabular-nums text-xs shrink-0 w-10 text-left"
              >
                {fmt(b.timestampMs)}
              </button>
              <span className="flex-1 min-w-0 truncate text-zinc-200" title={b.label}>
                {b.label || <span className="text-zinc-500">(no tags)</span>}
              </span>
              {b.visibility === 'private' && (
                <span title="Private — only you" className="text-zinc-500 shrink-0" aria-label="Private">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
                  </svg>
                </span>
              )}
              {(b.mine || isAdmin) && (
                <button
                  onClick={() => remove.mutate({ id: b.id, librarySlug })}
                  className="text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition shrink-0"
                  title="Delete bookmark" aria-label="Delete bookmark"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.5 9h6l.5-9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
