'use client';

/**
 * Client component for /admin/storage. Disk-Utility-style two-pane layout: a
 * list of drives on the left, and the selected drive's full panel (capacity,
 * stats, Run menu, actions, and its own job log) on the right.
 */

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { AddStorageDialog } from './AddStorageDialog';
import { RelocateDialog } from './RelocateDialog';
import { ProcessorLoadControl } from './ProcessorLoadControl';
import { DriveSidebar } from './DriveSidebar';
import { DriveDetail } from './DriveDetail';

export function StorageClient() {
  const utils = trpc.useUtils();
  // While a job is running/queued its indexing/enrichment keeps changing the
  // per-storage "files indexed" counts — poll the list so they update live.
  const [jobActive, setJobActive] = useState(false);
  // Which drives have a running/queued job right now — drives the sidebar
  // activity indicator. Polled across ALL drives (not just the selected one).
  const [activeStorageIds, setActiveStorageIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/admin/jobs', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json() as { jobs: Array<{ status: string; storageId: number | null }> };
        const ids = new Set<number>();
        for (const j of data.jobs) {
          if ((j.status === 'running' || j.status === 'queued') && j.storageId != null) ids.add(j.storageId);
        }
        if (!stop) setActiveStorageIds(ids);
      } catch { /* best-effort */ }
    };
    void poll();
    const t = setInterval(poll, 2500);
    return () => { stop = true; clearInterval(t); };
  }, []);
  const anyActive = jobActive || activeStorageIds.size > 0;
  const list = trpc.storage.list.useQuery(undefined, {
    refetchInterval: anyActive ? 3000 : false,
  });
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !anyActive) void utils.storage.list.invalidate();
    wasActive.current = anyActive;
  }, [anyActive, utils]);
  const current = trpc.library.current.useQuery();

  const remove = trpc.storage.remove.useMutation({
    onSuccess: () => utils.storage.list.invalidate(),
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [relocateId, setRelocateId] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [enqueuedToast, setEnqueuedToast] = useState<{ label: string; count: number } | null>(null);

  // Default the selection to the first drive; keep it valid if the list changes.
  const drives = list.data ?? [];
  useEffect(() => {
    if (drives.length === 0) { setSelectedId(null); return; }
    if (selectedId == null || !drives.some((d) => d.id === selectedId)) {
      setSelectedId(drives[0].id);
    }
  }, [drives, selectedId]);

  const selected = drives.find((d) => d.id === selectedId) ?? null;

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
          {list.data ? `${list.data.length} drive${list.data.length === 1 ? '' : 's'}` : 'Loading…'}
        </div>
        <button
          type="button"
          onClick={() => { setErrorMsg(null); setAddOpen(true); }}
          className="px-3 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 rounded text-emerald-50 transition"
        >
          + Add Storage
        </button>
      </div>

      {errorMsg && (
        <div className="text-[11px] text-red-300 bg-red-950/30 ring-1 ring-red-900/40 rounded px-3 py-2">
          {errorMsg}
        </div>
      )}

      {enqueuedToast && (
        <div className="text-xs text-emerald-200 bg-emerald-950/40 ring-1 ring-emerald-900/50 rounded px-3 py-2 flex items-center justify-between gap-3">
          <span>
            <span className="font-medium">{enqueuedToast.label}</span> enqueued
            <span className="text-emerald-400/80">
              {' · '}{enqueuedToast.count} {enqueuedToast.count === 1 ? 'job' : 'jobs'} queued
            </span>
            <span className="text-emerald-400/60"> — progress in this drive&apos;s log below.</span>
          </span>
          <button type="button" onClick={() => setEnqueuedToast(null)} className="text-emerald-400/70 hover:text-emerald-200 shrink-0" aria-label="Dismiss">×</button>
        </div>
      )}

      {drives.length === 0 ? (
        <div className="ring-1 ring-zinc-800 rounded-lg px-4 py-10 text-center text-sm text-zinc-500">
          No storage locations. Add one to start indexing.
        </div>
      ) : (
        <div className="flex gap-6 items-start">
          <DriveSidebar drives={drives} selectedId={selectedId} onSelect={setSelectedId} activeStorageIds={activeStorageIds} />
          <div className="flex-1 min-w-0 ring-1 ring-zinc-800 rounded-lg bg-zinc-950/40 p-5">
            {selected && (
              <DriveDetail
                drive={selected}
                librarySlug={current.data?.slug}
                onActiveChange={setJobActive}
                onEnqueued={(label, jobIds) => {
                  setErrorMsg(null);
                  setEnqueuedToast({ label, count: jobIds.length });
                }}
                onError={(msg) => { setEnqueuedToast(null); setErrorMsg(msg); }}
                onRelocate={(id) => { setErrorMsg(null); setRelocateId(id); }}
                onRemove={handleRemove}
                removePending={remove.isPending}
              />
            )}
          </div>
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-zinc-900">
        <ProcessorLoadControl />
      </div>

      {addOpen && (
        <AddStorageDialog
          onCancel={() => setAddOpen(false)}
          onAdded={() => { setAddOpen(false); utils.storage.list.invalidate(); }}
        />
      )}
      {relocateId !== null && list.data && (() => {
        const storage = list.data.find((s) => s.id === relocateId);
        if (!storage) return null;
        return (
          <RelocateDialog
            storage={storage}
            onCancel={() => setRelocateId(null)}
            onRelocated={() => { setRelocateId(null); utils.storage.list.invalidate(); }}
          />
        );
      })()}
    </div>
  );
}
