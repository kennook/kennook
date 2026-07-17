'use client';

/**
 * Right pane of the Disk-Utility-style storage admin: everything about ONE
 * drive — a capacity bar, indexed stats, the Run menu, Browse/Relocate/Remove
 * actions, and this drive's own job log (JobsPanel scoped to storageId).
 */

import Link from 'next/link';
import type { StorageInfo } from '@/server/storage';
import { RunStorageMenu } from './RunStorageMenu';
import { JobsPanel } from './JobsPanel';

function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatRelative(ms: number | null): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function DriveDetail({
  drive,
  librarySlug,
  onActiveChange,
  onEnqueued,
  onError,
  onRelocate,
  onRemove,
  removePending,
}: {
  drive: StorageInfo;
  librarySlug: string | undefined;
  onActiveChange: (active: boolean) => void;
  onEnqueued: (label: string, jobIds: number[]) => void;
  onError: (message: string) => void;
  onRelocate: (id: number) => void;
  onRemove: (id: number, name: string) => void;
  removePending: boolean;
}) {
  const statusLabel = drive.exists === null ? 'cloud' : drive.exists ? 'online' : 'missing';
  const statusClass =
    drive.exists === null ? 'text-zinc-400 bg-zinc-800/60'
      : drive.exists ? 'text-emerald-300 bg-emerald-950/40'
        : 'text-red-300 bg-red-950/40';

  const runnable = librarySlug && drive.exists !== null && drive.root_path !== '/';

  // Capacity bar segments (Disk-Utility style): this library's footprint, other
  // usage on the same filesystem, and free space. Only shown when statfs gave us
  // a capacity (mounted local drive).
  const cap = drive.capacity_bytes;
  const free = drive.free_bytes;
  const lib = drive.library_bytes;
  const hasCapacity = cap != null && cap > 0 && free != null;
  const otherUsed = hasCapacity ? Math.max(0, cap - free - lib) : 0;
  const pct = (n: number) => (hasCapacity ? `${Math.max(0, Math.min(100, (n / cap!) * 100))}%` : '0%');

  return (
    <div className="min-w-0">
      {/* Header: name, type, status */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-zinc-100 truncate">{drive.name}</h2>
            <span className={`inline-block px-2 py-0.5 rounded text-[11px] ${statusClass}`}>{statusLabel}</span>
            {drive.is_default && <span className="text-[11px] text-zinc-600">[default]</span>}
          </div>
          <div className="font-mono text-xs text-zinc-500 mt-1 break-all">{drive.root_path}</div>
        </div>
        {hasCapacity && (
          <div className="text-right shrink-0">
            <div className="text-2xl font-semibold text-zinc-100 tabular-nums">{formatBytes(cap)}</div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">capacity</div>
          </div>
        )}
      </div>

      {/* Capacity bar */}
      {hasCapacity ? (
        <div className="mb-5">
          <div className="h-3 w-full rounded-full overflow-hidden bg-zinc-900 ring-1 ring-zinc-800 flex">
            <div className="bg-emerald-500/80 h-full" style={{ width: pct(lib) }} title={`This library — ${formatBytes(lib)}`} />
            <div className="bg-zinc-600 h-full" style={{ width: pct(otherUsed) }} title={`Other data on this drive — ${formatBytes(otherUsed)}`} />
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-xs">
            <Legend dot="bg-emerald-500/80" label="This library" value={formatBytes(lib)} />
            <Legend dot="bg-zinc-600" label="Other" value={formatBytes(otherUsed)} />
            <Legend dot="bg-zinc-900 ring-1 ring-zinc-700" label="Free" value={formatBytes(free)} />
          </div>
        </div>
      ) : (
        <div className="mb-5 text-xs text-zinc-500">
          {drive.exists === false ? 'Drive offline — capacity unavailable.' : 'Capacity unavailable for this storage.'}
        </div>
      )}

      {/* Indexed stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Stat label="Indexed items" value={drive.file_count.toLocaleString()} />
        <Stat label="Library footprint" value={formatBytes(lib)} />
        <Stat label="Last indexed" value={formatRelative(drive.last_indexed_at)}
          title={drive.last_indexed_at ? new Date(drive.last_indexed_at).toLocaleString() : 'No indexer run recorded yet'} />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {runnable && (
          <RunStorageMenu
            librarySlug={librarySlug!}
            rootPath={drive.root_path}
            storageId={drive.id}
            onEnqueued={onEnqueued}
            onError={onError}
          />
        )}
        {drive.exists !== null && drive.root_path !== '/' && (
          <Link
            href={`/admin/storage/${drive.id}`}
            className="px-2.5 py-1 text-xs text-zinc-300 hover:text-zinc-100 ring-1 ring-zinc-800 hover:ring-zinc-700 rounded transition"
          >
            Browse
          </Link>
        )}
        <button
          type="button"
          onClick={() => onRelocate(drive.id)}
          className="px-2.5 py-1 text-xs text-zinc-300 hover:text-zinc-100 ring-1 ring-zinc-800 hover:ring-zinc-700 rounded transition"
        >
          Relocate
        </button>
        <button
          type="button"
          onClick={() => onRemove(drive.id, drive.name)}
          disabled={drive.file_count > 0 || removePending}
          className="px-2.5 py-1 text-xs text-red-300 hover:text-red-100 ring-1 ring-red-950 hover:ring-red-900 rounded transition
                     disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-red-300"
          title={drive.file_count > 0 ? 'Cannot remove a storage that still has files' : undefined}
        >
          Remove
        </button>
      </div>

      {/* This drive's job log */}
      <div className="pt-5 border-t border-zinc-900">
        <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Jobs — {drive.name}</h3>
        <JobsPanel key={drive.id} storageId={drive.id} onActiveChange={onActiveChange} />
      </div>
    </div>
  );
}

function Legend({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-zinc-400">
      <span className={`inline-block w-2.5 h-2.5 rounded-sm ${dot}`} />
      {label} <span className="text-zinc-300 tabular-nums">{value}</span>
    </span>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-lg ring-1 ring-zinc-800 bg-zinc-950/40 px-3 py-2" title={title}>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-sm text-zinc-200 tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
