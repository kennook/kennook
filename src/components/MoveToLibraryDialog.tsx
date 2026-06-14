'use client';

import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

interface SelectionRef {
  librarySlug: string;
  itemUuid: string;
}

interface Props {
  selection: SelectionRef[];
  onClose: () => void;
  /** Called once at least one item moved (parent clears selection + closes). */
  onMoved: () => void;
}

/**
 * Move the selected items into a different library. Pick a target library + a
 * storage location there; the server relocates each file (preserving its
 * relative path), hard-removes it from the source, and queues re-index +
 * enrichment in the target. Destructive — files move on disk — so it confirms
 * before firing.
 */
export function MoveToLibraryDialog({ selection, onClose, onMoved }: Props) {
  const current = trpc.library.current.useQuery();
  const libraries = trpc.library.list.useQuery();

  const targets = useMemo(
    () => (libraries.data ?? []).filter((l) => l.slug !== current.data?.slug),
    [libraries.data, current.data?.slug],
  );

  const [targetSlug, setTargetSlug] = useState<string | null>(null);
  const effectiveTarget = targetSlug ?? targets[0]?.slug ?? null;

  const storages = trpc.storage.list.useQuery(
    { librarySlug: effectiveTarget ?? undefined },
    { enabled: !!effectiveTarget },
  );
  // Real (non catch-all) storages are the only valid move targets.
  const storageOptions = (storages.data ?? []).filter((s) => s.root_path !== '/');
  const [storageId, setStorageId] = useState<number | null>(null);
  const effectiveStorageId = storageId ?? storageOptions[0]?.id ?? null;

  // Reset the storage choice whenever the target library changes.
  useEffect(() => { setStorageId(null); }, [effectiveTarget]);

  const move = trpc.media.moveToLibrary.useMutation();

  const targetName = targets.find((l) => l.slug === effectiveTarget)?.name;
  const count = selection.length;
  const canMove =
    !!effectiveTarget && effectiveStorageId != null && storageOptions.length > 0 && !move.isPending;

  const submit = () => {
    if (!effectiveTarget || effectiveStorageId == null) return;
    move.mutate(
      {
        items: selection.map((s) => ({ librarySlug: s.librarySlug, itemUuid: s.itemUuid })),
        targetLibrarySlug: effectiveTarget,
        targetStorageId: effectiveStorageId,
      },
      {
        // If everything failed, keep the dialog open to show why.
        onSuccess: (res) => { if (res.moved > 0) onMoved(); },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/70" />
      <div
        className="relative bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-md
                   shadow-2xl flex flex-col"
        role="dialog"
        aria-label="Move to library"
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-zinc-500">Move to library</div>
            <div className="text-sm text-zinc-200">{count} item{count === 1 ? '' : 's'}</div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 px-2" aria-label="Close">×</button>
        </div>

        {targets.length === 0 ? (
          <div className="p-4 text-sm text-zinc-400">
            There&rsquo;s only one library. Create another to move items into it.
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {/* Only one possible target → no point in a dropdown; show it. */}
            <div className="text-xs text-zinc-400">
              Target library
              {targets.length === 1 ? (
                <div className="mt-1 px-3 py-2 text-sm text-zinc-200 bg-zinc-900 border border-zinc-800 rounded">
                  {targets[0].name}
                </div>
              ) : (
                <select
                  value={effectiveTarget ?? ''}
                  onChange={(e) => setTargetSlug(e.target.value)}
                  className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm
                             text-zinc-200 focus:border-zinc-600 outline-none"
                >
                  {targets.map((l) => <option key={l.slug} value={l.slug}>{l.name}</option>)}
                </select>
              )}
            </div>

            <div className="text-xs text-zinc-400">
              Storage location
              {storageOptions.length === 0 ? (
                <div className="mt-1 text-[11px] text-amber-300/80 bg-amber-950/20 ring-1 ring-amber-900/40
                                rounded px-3 py-2">
                  {storages.isLoading
                    ? 'Loading…'
                    : `“${targetName}” has no storage location to move into. Add one in its Storage admin first.`}
                </div>
              ) : storageOptions.length === 1 ? (
                <div className="mt-1 px-3 py-2 text-sm text-zinc-200 bg-zinc-900 border border-zinc-800 rounded break-all">
                  {storageOptions[0].name}{' '}
                  <span className="text-zinc-500">— {storageOptions[0].root_path}</span>
                </div>
              ) : (
                <select
                  value={effectiveStorageId ?? ''}
                  onChange={(e) => setStorageId(Number(e.target.value))}
                  className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm
                             text-zinc-200 focus:border-zinc-600 outline-none"
                >
                  {storageOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} — {s.root_path}</option>
                  ))}
                </select>
              )}
            </div>

            <p className="text-[11px] text-zinc-500">
              Files are <span className="text-zinc-400">moved on disk</span> into{' '}
              <span className="text-zinc-400">{targetName}</span> (keeping their folder structure),
              removed from the current library, then re-indexed there. This can&rsquo;t be undone.
            </p>

            {move.data && move.data.failed.length > 0 && (
              <div className="text-[11px] text-red-300 bg-red-950/30 ring-1 ring-red-900/40 rounded px-3 py-2">
                {move.data.moved > 0 ? `Moved ${move.data.moved}. ` : ''}
                {move.data.failed.length} couldn&rsquo;t be moved
                {move.data.failed[0] ? `: ${move.data.failed[0].error}` : ''}.
              </div>
            )}
            {move.error && (
              <div className="text-[11px] text-red-300 bg-red-950/30 ring-1 ring-red-900/40 rounded px-3 py-2">
                {move.error.message}
              </div>
            )}
          </div>
        )}

        <div className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canMove}
            className="px-3 py-1.5 text-sm rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-50
                       disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {move.isPending ? 'Moving…' : `Move ${count} item${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
