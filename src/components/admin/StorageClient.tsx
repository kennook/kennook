'use client';

/**
 * Client component for /admin/storage. Renders the storage table, opens
 * dialogs for Add and Relocate, and invalidates the list query after each
 * mutation so the UI reflects the new state immediately.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { AddStorageDialog } from './AddStorageDialog';
import { RelocateDialog } from './RelocateDialog';
import { RunStorageMenu } from './RunStorageMenu';
import { JobsPanel } from './JobsPanel';

/** Compact relative-time string for the Last Indexed column. */
function formatRelative(ms: number | null): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function StorageClient() {
  const utils = trpc.useUtils();
  const list = trpc.storage.list.useQuery();
  // Current library — needed to enqueue indexing/backfill/enrich jobs scoped
  // to this admin context. The Run menu pre-fills it so the user doesn't
  // re-select a library they already see in the sidebar.
  const current = trpc.library.current.useQuery();

  const remove = trpc.storage.remove.useMutation({
    onSuccess: () => utils.storage.list.invalidate(),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [relocateId, setRelocateId] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [enqueuedToast, setEnqueuedToast] = useState<{ label: string; count: number } | null>(null);

  const handleRemove = async (id: number, name: string) => {
    if (!confirm(`Remove storage "${name}"? Only allowed if no files reference it.`)) return;
    setErrorMsg(null);
    try {
      await remove.mutateAsync({ id });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          {list.data ? `${list.data.length} storage location${list.data.length === 1 ? '' : 's'}` : 'Loading…'}
        </div>
        <button
          type="button"
          onClick={() => { setErrorMsg(null); setAddOpen(true); }}
          className="px-3 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 rounded
                     text-emerald-50 transition"
        >
          + Add Storage
        </button>
      </div>

      {errorMsg && (
        <div className="text-[11px] text-red-300 bg-red-950/30 ring-1 ring-red-900/40
                        rounded px-3 py-2">
          {errorMsg}
        </div>
      )}

      {enqueuedToast && (
        <div className="text-xs text-emerald-200 bg-emerald-950/40 ring-1 ring-emerald-900/50
                        rounded px-3 py-2 flex items-center justify-between gap-3">
          <span>
            <span className="font-medium">{enqueuedToast.label}</span> enqueued
            <span className="text-emerald-400/80">
              {' · '}{enqueuedToast.count} {enqueuedToast.count === 1 ? 'job' : 'jobs'} queued
            </span>
            <span className="text-emerald-400/60"> — progress below. Pause or stop anytime; finished work is saved.</span>
          </span>
          <button
            type="button"
            onClick={() => setEnqueuedToast(null)}
            className="text-emerald-400/70 hover:text-emerald-200 shrink-0"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="ring-1 ring-zinc-800 rounded-lg overflow-visible">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/60 text-[11px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Root path</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-right px-4 py-2 font-medium">Files Indexed</th>
              <th className="text-right px-4 py-2 font-medium">Last Indexed</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((s) => {
              const statusLabel =
                s.exists === null ? 'cloud' : s.exists ? 'online' : 'missing';
              const statusClass =
                s.exists === null
                  ? 'text-zinc-400 bg-zinc-800/60'
                  : s.exists
                    ? 'text-emerald-300 bg-emerald-950/40'
                    : 'text-red-300 bg-red-950/40';
              return (
                <tr key={s.id} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                  <td className="px-4 py-3 align-top">
                    <div className="text-zinc-100">{s.name}</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      {s.type}
                      {s.is_default && <span className="ml-2 text-zinc-600">[default]</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top font-mono text-xs text-zinc-300 break-all">
                    {s.root_path}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-block px-2 py-0.5 rounded text-[11px] ${statusClass}`}>
                      {statusLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top text-right tabular-nums text-zinc-300">
                    {s.file_count.toLocaleString()}
                  </td>
                  <td
                    className="px-4 py-3 align-top text-right text-xs text-zinc-400 tabular-nums whitespace-nowrap"
                    title={s.last_indexed_at ? new Date(s.last_indexed_at).toLocaleString() : 'No indexer run recorded yet'}
                  >
                    {formatRelative(s.last_indexed_at)}
                  </td>
                  <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                    {/* Run menu only makes sense for storages that point at a real, non-`/`
                        folder — running an indexer pass against `/` would scan the whole disk. */}
                    {current.data && s.exists !== null && s.root_path !== '/' && (
                      <RunStorageMenu
                        librarySlug={current.data.slug}
                        rootPath={s.root_path}
                        onEnqueued={(label, jobIds) => {
                          setErrorMsg(null);
                          setEnqueuedToast({ label, count: jobIds.length });
                        }}
                        onError={(msg) => {
                          setEnqueuedToast(null);
                          setErrorMsg(msg);
                        }}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => { setErrorMsg(null); setRelocateId(s.id); }}
                      className="ml-2 px-2.5 py-1 text-xs text-zinc-300 hover:text-zinc-100
                                 ring-1 ring-zinc-800 hover:ring-zinc-700 rounded transition"
                    >
                      Relocate
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(s.id, s.name)}
                      disabled={s.file_count > 0 || remove.isPending}
                      className="ml-2 px-2.5 py-1 text-xs text-red-300 hover:text-red-100
                                 ring-1 ring-red-950 hover:ring-red-900 rounded transition
                                 disabled:opacity-30 disabled:cursor-not-allowed
                                 disabled:hover:text-red-300"
                      title={s.file_count > 0 ? 'Cannot remove a storage that still has files' : undefined}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
            {list.data?.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-500">
                No storage locations. Add one to start indexing.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <JobsPanel />

      {addOpen && (
        <AddStorageDialog
          onCancel={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            utils.storage.list.invalidate();
          }}
        />
      )}
      {relocateId !== null && list.data && (() => {
        const storage = list.data.find((s) => s.id === relocateId);
        if (!storage) return null;
        return (
          <RelocateDialog
            storage={storage}
            onCancel={() => setRelocateId(null)}
            onRelocated={() => {
              setRelocateId(null);
              utils.storage.list.invalidate();
            }}
          />
        );
      })()}
    </div>
  );
}
