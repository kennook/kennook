'use client';

/**
 * Full-page file manager for one storage. Lazily browses the real filesystem
 * (each folder fetched on expand), shows indexed / ignored status, and lets you
 * multi-select files/folders to Ignore, Remove from library, or Delete from
 * disk. Folder selection implies its whole subtree (the backend resolves it).
 */

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc-client';
import type { BrowseEntry } from '@/server/storage-browse';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export function StorageBrowser({ storageId }: { storageId: number }) {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const root = trpc.storage.browse.useQuery({ storageId, dir: '' });

  const afterAction = () => {
    void utils.storage.browse.invalidate();
    void utils.storage.list.invalidate();
    setSelected(new Set());
    setError(null);
  };
  const onErr = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const ignore = trpc.storage.ignore.useMutation({ onSuccess: afterAction, onError: onErr });
  const unignore = trpc.storage.unignore.useMutation({ onSuccess: afterAction, onError: onErr });
  const remove = trpc.storage.removeFromLibrary.useMutation({ onSuccess: afterAction, onError: onErr });
  const del = trpc.storage.deleteFromDisk.useMutation({
    onSuccess: () => { afterAction(); setConfirmDelete(false); }, onError: (e) => { onErr(e); setConfirmDelete(false); },
  });

  const paths = [...selected];
  const busy = ignore.isPending || unignore.isPending || remove.isPending || del.isPending;

  const toggleSelect = (p: string) => setSelected((s) => {
    const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n;
  });
  const toggleExpand = (p: string) => setExpanded((s) => {
    const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n;
  });

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <Link href="/admin/storage" className="text-xs text-zinc-500 hover:text-zinc-300">← Storage</Link>
      </div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-1">Browse files</h1>
      <p className="text-sm text-zinc-400 mb-4 font-mono truncate">{root.data?.root ?? ''}</p>

      <div className="flex items-center justify-between mb-3">
        <label className="flex items-center gap-2 text-xs text-zinc-400 select-none">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden (dot-files)
        </label>
        {selected.size > 0 && (
          <button onClick={() => setSelected(new Set())} className="text-xs text-zinc-500 hover:text-zinc-300">
            clear selection ({selected.size})
          </button>
        )}
      </div>

      {error && (
        <div className="text-[11px] text-red-300 bg-red-950/30 ring-1 ring-red-900/40 rounded px-3 py-2 mb-3">{error}</div>
      )}

      {/* Action bar */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-zinc-950/90 backdrop-blur ring-1 ring-zinc-800 rounded-lg px-3 py-2 mb-3">
          <span className="text-xs text-zinc-400 mr-1">{selected.size} selected:</span>
          <button disabled={busy} onClick={() => ignore.mutate({ storageId, paths })}
            className="px-2.5 py-1 text-xs rounded ring-1 ring-amber-900/50 text-amber-200 hover:bg-amber-950/40 disabled:opacity-40">
            Ignore
          </button>
          <button disabled={busy} onClick={() => unignore.mutate({ storageId, paths })}
            className="px-2.5 py-1 text-xs rounded ring-1 ring-zinc-800 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40">
            Un-ignore
          </button>
          <button disabled={busy} onClick={() => remove.mutate({ storageId, paths })}
            className="px-2.5 py-1 text-xs rounded ring-1 ring-zinc-800 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40">
            Remove from library
          </button>
          <button disabled={busy} onClick={() => setConfirmDelete(true)}
            className="px-2.5 py-1 text-xs rounded ring-1 ring-red-900/60 text-red-300 hover:bg-red-950/40 disabled:opacity-40">
            Delete from disk…
          </button>
        </div>
      )}

      {/* Tree */}
      <div className="ring-1 ring-zinc-800 rounded-lg bg-zinc-950/40 py-1 min-h-[8rem]">
        {root.isLoading && <div className="px-3 py-2 text-sm text-zinc-500">Loading…</div>}
        {root.data && !root.data.exists && <div className="px-3 py-2 text-sm text-zinc-500">Storage folder not available.</div>}
        {root.data?.entries.map((e) => (
          <TreeNode key={e.path} storageId={storageId} entry={e} depth={0}
            expanded={expanded} toggleExpand={toggleExpand}
            selected={selected} toggleSelect={toggleSelect} showHidden={showHidden} />
        ))}
      </div>

      {confirmDelete && (
        <DeleteConfirm
          count={selected.size}
          pending={del.isPending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => del.mutate({ storageId, paths })}
        />
      )}
    </div>
  );
}

function TreeNode({
  storageId, entry, depth, expanded, toggleExpand, selected, toggleSelect, showHidden,
}: {
  storageId: number;
  entry: BrowseEntry;
  depth: number;
  expanded: Set<string>;
  toggleExpand: (p: string) => void;
  selected: Set<string>;
  toggleSelect: (p: string) => void;
  showHidden: boolean;
}) {
  const isDir = entry.kind === 'dir';
  const isOpen = expanded.has(entry.path);
  const children = trpc.storage.browse.useQuery(
    { storageId, dir: entry.path },
    { enabled: isDir && isOpen },
  );
  const isSelected = selected.has(entry.path);
  const hidden = entry.name.startsWith('.');
  if (hidden && !showHidden) return null;

  return (
    <>
      <div
        className={`flex items-center gap-2 pr-3 py-1 text-sm hover:bg-zinc-900/50
                    ${isSelected ? 'bg-emerald-950/30' : ''}`}
        style={{ paddingLeft: `${depth * 18 + 8}px` }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => toggleSelect(entry.path)}
          className="shrink-0"
        />
        {isDir ? (
          <button onClick={() => toggleExpand(entry.path)} className="w-4 shrink-0 text-zinc-500 hover:text-zinc-300">
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="shrink-0 text-zinc-500">
          {isDir ? '📁' : entry.mediaKind === 'photo' ? '🖼' : entry.mediaKind === 'video' ? '🎬' : '📄'}
        </span>
        <span className={`truncate ${entry.ignored ? 'text-zinc-600 line-through' : hidden ? 'text-zinc-600' : 'text-zinc-200'}`}>
          {entry.name}
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0 text-[11px] tabular-nums">
          {entry.ignored && <span className="text-amber-500/80 no-underline">ignored</span>}
          {isDir && (entry.indexedCount ?? 0) > 0 && (
            <span className="text-emerald-500/70">{entry.indexedCount!.toLocaleString()} indexed</span>
          )}
          {!isDir && entry.mediaKind && (
            <span className={entry.indexed ? 'text-emerald-500/70' : 'text-zinc-600'}>
              {entry.indexed ? 'indexed' : 'not indexed'}
            </span>
          )}
          {!isDir && <span className="text-zinc-600 w-14 text-right">{formatBytes(entry.sizeBytes ?? 0)}</span>}
        </span>
      </div>
      {isDir && isOpen && (
        <>
          {children.isLoading && (
            <div className="text-xs text-zinc-600 py-1" style={{ paddingLeft: `${(depth + 1) * 18 + 30}px` }}>loading…</div>
          )}
          {children.data?.entries.map((c) => (
            <TreeNode key={c.path} storageId={storageId} entry={c} depth={depth + 1}
              expanded={expanded} toggleExpand={toggleExpand}
              selected={selected} toggleSelect={toggleSelect} showHidden={showHidden} />
          ))}
          {children.data && children.data.entries.length === 0 && (
            <div className="text-xs text-zinc-600 py-1" style={{ paddingLeft: `${(depth + 1) * 18 + 30}px` }}>empty</div>
          )}
        </>
      )}
    </>
  );
}

function DeleteConfirm({
  count, pending, onCancel, onConfirm,
}: { count: number; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [text, setText] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="w-full max-w-md bg-zinc-900 ring-1 ring-red-900/50 rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-red-200 mb-2">Delete from disk — permanent</h2>
        <p className="text-sm text-zinc-400 mb-3">
          This removes {count} selected item{count === 1 ? '' : 's'} from the library <em>and permanently deletes the
          files/folders on disk</em> (folders are removed recursively, including any non-media files inside). This cannot be undone.
        </p>
        <p className="text-xs text-zinc-500 mb-1">Type <span className="font-mono text-zinc-300">DELETE</span> to confirm:</p>
        <input
          autoFocus value={text} onChange={(e) => setText(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm mb-4 focus:border-red-800 outline-none"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            disabled={text !== 'DELETE' || pending}
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded bg-red-800 hover:bg-red-700 text-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
