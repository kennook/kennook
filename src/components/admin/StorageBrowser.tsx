'use client';

/**
 * Full-page file manager for one storage. Lazily browses the real filesystem
 * (each folder fetched on expand), shows indexed / ignored status + a preview
 * for indexed media, and lets you multi-select files/folders to Ignore, Remove
 * from library, or Delete from disk. Folder selection implies its whole subtree
 * (the backend resolves it). A pinned header carries the filter + action bar so
 * you never have to scroll up to act.
 */

import { useMemo, useRef, useState } from 'react';
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

/** name → does it pass the current filter. */
type Matcher = (name: string) => boolean;

interface Vis { showHidden: boolean; showIgnored: boolean; showIncompatible: boolean }

/** Does an entry pass the visibility toggles? Hidden (dot), ignored, and
 *  incompatible (a file KenNook can't view — no media kind) are all off by
 *  default so the user sees a clean list of usable, un-ignored media. */
function passesVisibility(e: BrowseEntry, v: Vis): boolean {
  if (e.name.startsWith('.') && !v.showHidden) return false;
  if (e.ignored && !v.showIgnored) return false;
  if (e.kind === 'file' && !e.mediaKind && !v.showIncompatible) return false;
  return true;
}

export function StorageBrowser({ storageId }: { storageId: number }) {
  const utils = trpc.useUtils();
  const lib = trpc.library.current.useQuery();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [showIncompatible, setShowIncompatible] = useState(false);
  const [visMenuOpen, setVisMenuOpen] = useState(false);
  const vis: Vis = { showHidden, showIgnored, showIncompatible };
  const [filter, setFilter] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState<{ uuid: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const root = trpc.storage.browse.useQuery({ storageId, dir: '' });

  const { matcher, regexError } = useMemo<{ matcher: Matcher; regexError: boolean }>(() => {
    const q = filter.trim();
    if (!q) return { matcher: () => true, regexError: false };
    if (useRegex) {
      try { const re = new RegExp(q, 'i'); return { matcher: (n) => re.test(n), regexError: false }; }
      catch { return { matcher: () => true, regexError: true }; }
    }
    const lc = q.toLowerCase();
    return { matcher: (n) => n.toLowerCase().includes(lc), regexError: false };
  }, [filter, useRegex]);

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
  const toggleExpand = (p: string) => setExpanded((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  // The flattened, in-render-order list of currently-VISIBLE row paths — rebuilt
  // from the browse cache using the same visibility rules as the tree. Powers
  // shift+click range select and "select all (visible)".
  const visiblePaths = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      const data = utils.storage.browse.getData({ storageId, dir });
      if (!data) return;
      for (const e of data.entries) {
        if (!passesVisibility(e, vis)) continue;
        const isDir = e.kind === 'dir';
        const isOpen = expanded.has(e.path);
        if (!matcher(e.name) && !(isDir && isOpen)) continue;
        out.push(e.path);
        if (isDir && isOpen) walk(e.path);
      }
    };
    walk('');
    return out;
  };

  // Click a row's checkbox. Shift extends a contiguous range from the last
  // anchor through the clicked row (in visible order); plain click toggles and
  // becomes the new anchor.
  const anchorRef = useRef<string | null>(null);
  const onSelect = (p: string, shift: boolean) => {
    if (shift && anchorRef.current && anchorRef.current !== p) {
      const order = visiblePaths();
      const a = order.indexOf(anchorRef.current);
      const b = order.indexOf(p);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected((s) => { const n = new Set(s); for (let i = lo; i <= hi; i++) n.add(order[i]); return n; });
        return;
      }
    }
    setSelected((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
    anchorRef.current = p;
  };
  const selectAllVisible = () => setSelected(new Set(visiblePaths()));

  const btn = 'px-2.5 py-1 text-xs rounded ring-1 disabled:opacity-40';

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <Link href="/admin/storage" className="text-xs text-zinc-500 hover:text-zinc-300">← Storage</Link>
      </div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-1">Browse files</h1>
      <p className="text-sm text-zinc-500 mb-4 font-mono truncate">{root.data?.root ?? ''}</p>

      {/* Pinned header: filter + toggles + action bar. Sticks to the top of the
          scrolling <main> so actions are always reachable. */}
      <div className="sticky top-0 z-20 -mx-8 px-8 py-3 bg-zinc-950/95 backdrop-blur border-b border-zinc-900 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={useRegex ? 'Filter by regex…' : 'Filter by name…'}
            className={`flex-1 min-w-[12rem] bg-zinc-950 border rounded px-2.5 py-1.5 text-sm outline-none
                        ${regexError ? 'border-red-800' : 'border-zinc-800 focus:border-zinc-600'}`}
          />
          <label className="flex items-center gap-1.5 text-xs text-zinc-400 select-none">
            <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} /> regex
          </label>
          <div className="relative">
            <button onClick={() => setVisMenuOpen((o) => !o)}
              className="text-xs text-zinc-400 hover:text-zinc-200 ring-1 ring-zinc-800 hover:ring-zinc-700 rounded px-2 py-1.5">
              Show ▾
            </button>
            {visMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setVisMenuOpen(false)} />
                <div className="absolute left-0 mt-1 z-40 w-52 bg-zinc-900 ring-1 ring-zinc-800 rounded-lg p-2 space-y-0.5 shadow-xl">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600 px-1.5 pb-1">Also show</div>
                  <VisToggle label="Hidden files (dot-files)" checked={showHidden} onChange={setShowHidden} />
                  <VisToggle label="Ignored" checked={showIgnored} onChange={setShowIgnored} />
                  <VisToggle label="Incompatible (unviewable)" checked={showIncompatible} onChange={setShowIncompatible} />
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button onClick={selectAllVisible} className="text-zinc-400 hover:text-zinc-200">Select all</button>
            <span className="text-zinc-700">·</span>
            <button onClick={() => setSelected(new Set())} className="text-zinc-400 hover:text-zinc-200">Select none</button>
          </div>
          {selected.size > 0 && <span className="text-xs text-emerald-500/70">{selected.size} selected</span>}
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-400 mr-1">{selected.size} selected:</span>
            <button disabled={busy} onClick={() => ignore.mutate({ storageId, paths })} className={`${btn} ring-amber-900/50 text-amber-200 hover:bg-amber-950/40`}>Ignore</button>
            <button disabled={busy} onClick={() => unignore.mutate({ storageId, paths })} className={`${btn} ring-zinc-800 text-zinc-300 hover:bg-zinc-900`}>Un-ignore</button>
            <button disabled={busy} onClick={() => remove.mutate({ storageId, paths })} className={`${btn} ring-zinc-800 text-zinc-300 hover:bg-zinc-900`}>Remove from library</button>
            <button disabled={busy} onClick={() => setConfirmDelete(true)} className={`${btn} ring-red-900/60 text-red-300 hover:bg-red-950/40`}>Delete from disk…</button>
          </div>
        )}
      </div>

      {error && <div className="text-[11px] text-red-300 bg-red-950/30 ring-1 ring-red-900/40 rounded px-3 py-2 my-3">{error}</div>}

      <div className="ring-1 ring-zinc-800 rounded-lg bg-zinc-950/40 py-1 min-h-[8rem] mt-3">
        {root.isLoading && <div className="px-3 py-2 text-sm text-zinc-500">Loading…</div>}
        {root.data && !root.data.exists && <div className="px-3 py-2 text-sm text-zinc-500">Storage folder not available.</div>}
        {root.data?.entries.map((e) => (
          <TreeNode key={e.path} storageId={storageId} entry={e} depth={0}
            expanded={expanded} toggleExpand={toggleExpand} selected={selected} onSelect={onSelect}
            vis={vis} matcher={matcher} onPreview={setPreview} />
        ))}
      </div>

      {confirmDelete && (
        <DeleteConfirm count={selected.size} pending={del.isPending}
          onCancel={() => setConfirmDelete(false)} onConfirm={() => del.mutate({ storageId, paths })} />
      )}
      {preview && lib.data && (
        <PreviewModal uuid={preview.uuid} name={preview.name} librarySlug={lib.data.slug} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function VisToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-300 hover:bg-zinc-800/60 rounded px-1.5 py-1 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className={`transition-transform ${open ? 'rotate-90' : ''} text-zinc-500`}>
      <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TreeNode({
  storageId, entry, depth, expanded, toggleExpand, selected, onSelect, vis, matcher, onPreview,
}: {
  storageId: number; entry: BrowseEntry; depth: number;
  expanded: Set<string>; toggleExpand: (p: string) => void;
  selected: Set<string>; onSelect: (p: string, shift: boolean) => void;
  vis: Vis; matcher: Matcher; onPreview: (p: { uuid: string; name: string }) => void;
}) {
  const isDir = entry.kind === 'dir';
  const isOpen = expanded.has(entry.path);
  const children = trpc.storage.browse.useQuery({ storageId, dir: entry.path }, { enabled: isDir && isOpen });
  const isSelected = selected.has(entry.path);
  const hidden = entry.name.startsWith('.');
  if (!passesVisibility(entry, vis)) return null;
  // Filter hides non-matching files and COLLAPSED non-matching folders; an
  // expanded folder stays visible so you can still drill in and filter its
  // children (otherwise filtering would hide the folder you opened).
  if (!matcher(entry.name) && !(isDir && isOpen)) return null;
  const canPreview = !isDir && entry.indexed && entry.uuid && (entry.mediaKind === 'photo' || entry.mediaKind === 'video');

  return (
    <>
      <div
        className={`group flex items-center gap-2 pr-3 py-1 text-sm hover:bg-zinc-900/50 ${isSelected ? 'bg-emerald-950/30' : ''}`}
        style={{ paddingLeft: `${depth * 18 + 8}px` }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => { /* controlled via onClick to capture shift */ }}
          onClick={(e) => { e.preventDefault(); onSelect(entry.path, e.shiftKey); }}
          className="shrink-0 cursor-pointer"
        />
        {isDir ? (
          <button onClick={() => toggleExpand(entry.path)} className="w-4 h-4 shrink-0 flex items-center justify-center hover:bg-zinc-800 rounded">
            <Chevron open={isOpen} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="shrink-0">{isDir ? (isOpen ? '📂' : '📁') : entry.mediaKind === 'photo' ? '🖼' : entry.mediaKind === 'video' ? '🎬' : '📄'}</span>
        <span className={`truncate ${entry.ignored ? 'text-zinc-600 line-through' : hidden ? 'text-zinc-600' : 'text-zinc-200'}`}>{entry.name}</span>
        {canPreview && (
          <button
            onClick={() => onPreview({ uuid: entry.uuid!, name: entry.name })}
            title="Preview / info"
            className="shrink-0 opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center text-[11px] rounded-full ring-1 ring-zinc-700 text-zinc-400 hover:text-zinc-100 hover:ring-zinc-500"
          >i</button>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0 text-[11px] tabular-nums">
          {entry.ignored && <span className="text-amber-500/80">ignored</span>}
          {isDir && (entry.indexedCount ?? 0) > 0 && <span className="text-emerald-500/70">{entry.indexedCount!.toLocaleString()} indexed</span>}
          {!isDir && entry.mediaKind && (
            <span
              className={entry.indexed ? 'text-emerald-500/70' : entry.duplicate ? 'text-sky-500/70' : 'text-zinc-600'}
              title={entry.duplicate ? 'Byte-identical duplicate of an already-indexed file — skipped on purpose' : undefined}
            >
              {entry.indexed ? 'indexed' : entry.duplicate ? 'duplicate' : 'not indexed'}
            </span>
          )}
          {!isDir && <span className="text-zinc-600 w-14 text-right">{formatBytes(entry.sizeBytes ?? 0)}</span>}
        </span>
      </div>
      {isDir && isOpen && (
        <>
          {children.isLoading && <div className="text-xs text-zinc-600 py-1" style={{ paddingLeft: `${(depth + 1) * 18 + 30}px` }}>loading…</div>}
          {children.data?.entries.map((c) => (
            <TreeNode key={c.path} storageId={storageId} entry={c} depth={depth + 1}
              expanded={expanded} toggleExpand={toggleExpand} selected={selected} onSelect={onSelect}
              vis={vis} matcher={matcher} onPreview={onPreview} />
          ))}
          {children.data && children.data.entries.length === 0 && (
            <div className="text-xs text-zinc-600 py-1" style={{ paddingLeft: `${(depth + 1) * 18 + 30}px` }}>empty</div>
          )}
        </>
      )}
    </>
  );
}

function PreviewModal({ uuid, name, librarySlug, onClose }: { uuid: string; name: string; librarySlug: string; onClose: () => void }) {
  const thumb = `/api/thumbnails/${encodeURIComponent(uuid)}?lib=${encodeURIComponent(librarySlug)}`;
  const appHref = `/?lib=${encodeURIComponent(librarySlug)}&q=${encodeURIComponent(uuid)}&item=${encodeURIComponent(uuid)}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-w-lg w-full bg-zinc-900 ring-1 ring-zinc-800 rounded-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={thumb} alt={name} className="w-full max-h-[70vh] object-contain bg-black" />
        <div className="p-3 flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-300 truncate font-mono">{name}</span>
          <div className="flex items-center gap-3 shrink-0">
            <a href={appHref} target="_blank" rel="noopener noreferrer" className="text-xs text-emerald-400 hover:text-emerald-300">Open in app ↗</a>
            <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirm({ count, pending, onCancel, onConfirm }: { count: number; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [text, setText] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="w-full max-w-md bg-zinc-900 ring-1 ring-red-900/50 rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-red-200 mb-2">Delete from disk — permanent</h2>
        <p className="text-sm text-zinc-400 mb-3">
          This removes {count} selected item{count === 1 ? '' : 's'} from the library <em>and permanently deletes the
          files/folders on disk</em> (folders removed recursively, including non-media files). This cannot be undone.
        </p>
        <p className="text-xs text-zinc-500 mb-1">Type <span className="font-mono text-zinc-300">DELETE</span> to confirm:</p>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm mb-4 focus:border-red-800 outline-none" />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button disabled={text !== 'DELETE' || pending} onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded bg-red-800 hover:bg-red-700 text-red-50 disabled:opacity-40 disabled:cursor-not-allowed">
            {pending ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
