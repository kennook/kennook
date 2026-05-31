'use client';

import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

interface ItemRef {
  uuid: string;
  librarySlug: string;
  filename?: string;
}

interface Props {
  /** UUID of the person the items are currently assigned to. */
  fromPersonUuid: string;
  /** Assets being reassigned. Single-item case wraps in a one-element array. */
  items: ItemRef[];
  /** Closes the dialog without action (Esc / backdrop / X). */
  onClose: () => void;
  /** Called after the server reassignment succeeds. */
  onReassigned: (result: {
    createdPersonUuid: string | null;
    movedFaces: number;
  }) => void;
}

/**
 * Reassign one or more faces from one person to another. Three target modes:
 *
 *   1. Pick an existing person — the most common case ("this is actually
 *      Bob, not Robert").
 *   2. Make a new person — split off into a fresh singleton cluster.
 *   3. Remove from this person — unassign entirely. Useful when the face
 *      doesn't match any known cluster.
 *
 * Works for batches via the SelectionBar (multi-select) or single items
 * via the viewer. The picker is a face-thumbnail grid (named first), with
 * a search box that only narrows to *labeled* people — searching by face
 * is what the thumbnails are for.
 */
export function ReassignPersonDialog({
  fromPersonUuid,
  items,
  onClose,
  onReassigned,
}: Props) {
  const [search, setSearch] = useState('');
  const utils = trpc.useUtils();
  // 'all' — reassigning a face must be able to target any clustered person,
  // including one not yet present in the current library.
  const people = trpc.people.list.useQuery({ scope: 'all' });

  const reassign = trpc.people.reassignFaces.useMutation({
    onSuccess: (result) => {
      // Lightweight refresh: face counts + the currently-viewed person's
      // photo list. We deliberately don't invalidate media.list/search to
      // avoid closing the open viewer — the underlying grid will refresh
      // naturally on the next navigation.
      utils.people.list.invalidate();
      utils.people.get.invalidate();
      onReassigned({
        createdPersonUuid: result.createdPersonUuid,
        movedFaces: result.movedFaces,
      });
    },
  });

  const batchPayload = items.map((it) => ({
    librarySlug: it.librarySlug,
    itemUuid: it.uuid,
  }));

  // What to show in the header — filename if 1, count if many.
  const headerLabel = items.length === 1
    ? (items[0].filename ?? items[0].uuid)
    : `${items.length} items`;

  const candidates = useMemo(() => {
    const all = people.data ?? [];
    // Don't offer the source person as a target.
    const others = all.filter((p) => p.uuid !== fromPersonUuid);
    const q = search.trim().toLowerCase();
    if (!q) return others;
    // Only labeled people are searchable by name; unlabeled clusters drop
    // out of the result when a query is typed (a search-by-face overlay
    // would help here later).
    return others.filter((p) => (p.name ?? '').toLowerCase().includes(q));
  }, [people.data, fromPersonUuid, search]);

  const submitting = reassign.isPending;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
      />
      <div
        className="relative bg-zinc-950 border border-zinc-800 rounded-xl w-full
                   max-w-md max-h-[85vh] flex flex-col shadow-2xl"
        role="dialog"
        aria-label="Reassign person"
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-zinc-500">
              Reassign {items.length > 1 ? `${items.length} items` : ''}
            </div>
            <div className="text-sm text-zinc-200 truncate">{headerLabel}</div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-3 border-b border-zinc-800 space-y-2">
          <button
            disabled={submitting}
            onClick={() => reassign.mutate({
              items: batchPayload,
              fromPersonUuid,
              to: { kind: 'new' },
            })}
            className="w-full text-left px-3 py-2 rounded bg-zinc-900 hover:bg-zinc-800
                       text-sm text-zinc-100 disabled:opacity-50 transition"
          >
            <div className="font-medium">Make a new person</div>
            <div className="text-xs text-zinc-500">
              {items.length > 1
                ? 'Pulls these faces into a fresh cluster together.'
                : 'Splits this face off into its own cluster.'}
            </div>
          </button>
          <button
            disabled={submitting}
            onClick={() => reassign.mutate({
              items: batchPayload,
              fromPersonUuid,
              to: { kind: 'unassign' },
            })}
            className="w-full text-left px-3 py-2 rounded bg-zinc-900 hover:bg-zinc-800
                       text-sm text-zinc-100 disabled:opacity-50 transition"
          >
            <div className="font-medium">
              Remove from this person {items.length > 1 ? '(all)' : ''}
            </div>
            <div className="text-xs text-zinc-500">
              Leaves the face{items.length > 1 ? 's' : ''} unassigned.
              Next cluster run may re-attach.
            </div>
          </button>
        </div>

        <div className="px-4 py-2 border-b border-zinc-800">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search named people…"
            className="w-full bg-zinc-900 border border-zinc-800 rounded
                       px-3 py-1.5 text-sm placeholder:text-zinc-500
                       focus:border-zinc-600 outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {people.isLoading ? (
            <div className="text-sm text-zinc-500 px-1 py-3">Loading…</div>
          ) : candidates.length === 0 ? (
            <div className="text-sm text-zinc-500 px-1 py-3">
              No matching people.
            </div>
          ) : (
            <div className="grid grid-cols-5 gap-2">
              {candidates.map((p) => {
                const tooltip = p.name
                  ? `${p.name} · ${p.faceCount} face${p.faceCount === 1 ? '' : 's'}`
                  : `${p.faceCount} face${p.faceCount === 1 ? '' : 's'}`;
                return (
                  <button
                    key={p.uuid}
                    disabled={submitting}
                    onClick={() => reassign.mutate({
                      items: batchPayload,
                      fromPersonUuid,
                      to: { kind: 'person', uuid: p.uuid },
                    })}
                    title={tooltip}
                    aria-label={tooltip}
                    className="relative aspect-square rounded-full overflow-hidden
                               bg-zinc-900 hover:ring-2 hover:ring-emerald-400
                               disabled:opacity-50 transition outline-none"
                  >
                    {p.coverThumbnailUrl && (
                      <img
                        src={p.coverThumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                    )}
                    {p.name && (
                      <span className="absolute bottom-0 inset-x-0 px-1 py-0.5
                                       bg-black/70 text-[9px] text-zinc-100 truncate
                                       text-center">
                        {p.name}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {reassign.error && (
          <div className="px-4 py-2 text-xs text-red-400 border-t border-zinc-800">
            {reassign.error.message}
          </div>
        )}
      </div>
    </div>
  );
}
