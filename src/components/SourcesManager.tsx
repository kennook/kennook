'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { trpc } from '@/lib/trpc-client';
import type { ExternalSourceKind } from '@/server/external-sources';

interface Source {
  slug: string;
  name: string;
  kind: ExternalSourceKind;
  category?: string;
}

interface Props {
  activeSourceSlug: string | null;
  activeCategory: string | null;
  onSelectSource: (slug: string | null) => void;
  onSelectCategory: (category: string | null) => void;
  /** Close the panel and return to the main sidebar content. */
  onBack: () => void;
}

/**
 * In-sidebar manager for external (YouTube) sources — a second layer that the
 * parent slides over the sidebar column (no backdrop, so it can't be dismissed
 * by clicking away; the "‹ Back" header returns to the main sidebar). Add,
 * filter, drag-to-reorder, inline-rename, and delete, with room for full titles.
 */
export function SourcesManager({
  activeSourceSlug, activeCategory, onSelectSource, onSelectCategory, onBack,
}: Props) {
  const utils = trpc.useUtils();
  const sources = trpc.externalSource.list.useQuery();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  // Local working order — the source of truth for drag-reorder. Resynced from
  // the server only when the SET of slugs changes (add/remove), so an in-session
  // reorder isn't clobbered by the refetch our own mutation triggers.
  const [items, setItems] = useState<Source[]>([]);
  useEffect(() => {
    const incoming = (sources.data ?? []).map((s) => ({ slug: s.slug, name: s.name, kind: s.kind, category: s.category }));
    setItems((prev) => {
      const a = new Set(prev.map((s) => s.slug));
      const b = new Set(incoming.map((s) => s.slug));
      const sameSet = a.size === b.size && [...a].every((s) => b.has(s));
      return sameSet ? prev.map((p) => incoming.find((i) => i.slug === p.slug) ?? p) : incoming;
    });
  }, [sources.data]);

  const remove = trpc.externalSource.remove.useMutation({
    onSuccess: (_d, vars) => {
      void utils.externalSource.list.invalidate();
      if (vars.slug === activeSourceSlug) onSelectSource(null);
    },
  });
  const reorder = trpc.externalSource.reorder.useMutation({
    onSuccess: () => void utils.externalSource.list.invalidate(),
  });
  const rename = trpc.externalSource.rename.useMutation({
    onSuccess: () => void utils.externalSource.list.invalidate(),
  });
  const setCategory = trpc.externalSource.setCategory.useMutation({
    onSuccess: () => void utils.externalSource.list.invalidate(),
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((s) => s.name.toLowerCase().includes(q)) : items;
  }, [items, query]);
  const canReorder = query.trim() === '';

  // Distinct categories across single-video/live sources — the group chips.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const s of items) if (s.kind === 'video' && s.category) set.add(s.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [overSlug, setOverSlug] = useState<string | null>(null);

  const dropOn = (targetSlug: string) => {
    if (!dragSlug || dragSlug === targetSlug) { setDragSlug(null); setOverSlug(null); return; }
    const next = [...items];
    const from = next.findIndex((s) => s.slug === dragSlug);
    const to = next.findIndex((s) => s.slug === targetSlug);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next);
    reorder.mutate({ slugs: next.map((s) => s.slug) });
    setDragSlug(null);
    setOverSlug(null);
  };

  // Picking a source / category switches the grid AND closes the panel.
  const pick = (slug: string | null) => { onSelectSource(slug); onBack(); };
  const pickCategory = (c: string | null) => { onSelectCategory(c); onBack(); };

  return (
    <div className="flex flex-col pr-2">
      {/* Shared datalist so each video source's category field suggests the
          categories already in use. */}
      <datalist id="kn-src-categories">
        {categories.map((c) => <option key={c} value={c} />)}
      </datalist>
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 transition"
      >
        <BackChevron />
        <span>Back</span>
      </button>

      <div className="flex items-center gap-2 px-3 pb-2">
        <YouTubeMark />
        <h3 className="flex-1 text-sm font-medium text-zinc-100">External sources</h3>
      </div>

      <div className="px-1 flex flex-col gap-2 mb-2">
        <button
          onClick={() => setAdding(true)}
          className="w-full flex items-center justify-center gap-1.5 rounded-md bg-zinc-200 text-zinc-900
                     text-sm font-medium py-1.5 hover:bg-white transition"
        >
          <span className="text-base leading-none">+</span> Add source
        </button>
        {items.length > 4 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-1.5 text-sm
                       outline-none focus:border-zinc-600"
          />
        )}
      </div>

      {categories.length > 0 && (
        <div className="px-3 pb-2">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Categories</div>
          <div className="flex flex-wrap gap-1">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => pickCategory(c)}
                title={`View all "${c}" live channels`}
                className={`px-2 py-0.5 rounded-full text-xs border transition
                            ${activeCategory === c
                              ? 'bg-sky-500/20 text-sky-300 border-sky-600/50'
                              : 'bg-zinc-900 text-zinc-300 border-zinc-800 hover:border-zinc-700'}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col">
        <Row
          label="Back to library"
          active={activeSourceSlug === null && activeCategory === null}
          onClick={() => pick(null)}
          leading={<LibraryIcon />}
        />
        {items.length > 0 && <div className="border-t border-zinc-800/70 my-1 mx-3" />}

        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">
            {items.length === 0 ? 'No sources yet — add one above.' : 'No matches.'}
          </div>
        )}

        {filtered.map((s) => (
          <SourceRow
            key={s.slug}
            source={s}
            active={s.slug === activeSourceSlug}
            draggable={canReorder}
            dragging={dragSlug === s.slug}
            dragOver={overSlug === s.slug && dragSlug !== s.slug}
            onDragStart={() => setDragSlug(s.slug)}
            onDragOver={() => setOverSlug(s.slug)}
            onDrop={() => dropOn(s.slug)}
            onDragEnd={() => { setDragSlug(null); setOverSlug(null); }}
            onOpen={() => pick(s.slug)}
            onRename={(name) => rename.mutate({ slug: s.slug, name })}
            onSetCategory={(category) => setCategory.mutate({ slug: s.slug, category })}
            onRemove={() => remove.mutate({ slug: s.slug })}
          />
        ))}
      </div>

      {items.length > 1 && canReorder && (
        <div className="px-3 pt-2 text-[11px] text-zinc-600">Drag to reorder</div>
      )}

      {adding && (
        <AddSourceDialog
          onClose={() => setAdding(false)}
          onAdded={(slug) => { setAdding(false); pick(slug); }}
        />
      )}
    </div>
  );
}

function SourceRow({
  source, active, draggable, dragging, dragOver,
  onDragStart, onDragOver, onDrop, onDragEnd, onOpen, onRename, onSetCategory, onRemove,
}: {
  source: Source;
  active: boolean;
  draggable: boolean;
  dragging: boolean;
  dragOver: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onRename: (name: string) => void;
  onSetCategory: (category: string) => void;
  onRemove: () => void;
}) {
  // A single inline edit slot — either the name (rename) or the category, chosen
  // from the kebab menu. Keeps the row itself down to grip · icon · name · ⋮.
  const [editMode, setEditMode] = useState<null | 'name' | 'category'>(null);
  const [nameDraft, setNameDraft] = useState(source.name);
  const [catDraft, setCatDraft] = useState(source.category ?? '');
  useEffect(() => { setCatDraft(source.category ?? ''); }, [source.category]);
  const editing = editMode !== null;

  const commitName = () => {
    const v = nameDraft.trim();
    if (v && v !== source.name) onRename(v);
    setEditMode(null);
  };
  const commitCat = () => {
    const v = catDraft.trim();
    if (v !== (source.category ?? '')) onSetCategory(v);
    setEditMode(null);
  };

  return (
    <div
      draggable={draggable && !editing}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-1 pl-1.5 pr-1 mx-1 rounded-md
                  ${active ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}
                  ${dragging ? 'opacity-40' : ''}
                  ${dragOver ? 'ring-1 ring-inset ring-sky-500/60' : ''}`}
    >
      {draggable && (
        <span className="text-zinc-600 group-hover:text-zinc-500 cursor-grab active:cursor-grabbing select-none" title="Drag to reorder">
          <GripIcon />
        </span>
      )}
      <KindIcon kind={source.kind} />
      {editMode === 'name' ? (
        <input
          autoFocus
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            else if (e.key === 'Escape') { setNameDraft(source.name); setEditMode(null); }
          }}
          onBlur={commitName}
          className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1 my-1 text-sm outline-none focus:border-zinc-500"
        />
      ) : editMode === 'category' ? (
        <input
          autoFocus
          list="kn-src-categories"
          value={catDraft}
          onChange={(e) => setCatDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCat();
            else if (e.key === 'Escape') { setCatDraft(source.category ?? ''); setEditMode(null); }
          }}
          onBlur={commitCat}
          placeholder="category (e.g. news)"
          className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1 my-1 text-sm outline-none focus:border-zinc-500"
        />
      ) : (
        <button
          onClick={onOpen}
          onDoubleClick={() => { setNameDraft(source.name); setEditMode('name'); }}
          title={source.name}
          className={`flex-1 min-w-0 text-left py-2 text-sm truncate ${active ? 'text-zinc-100' : 'text-zinc-300'}`}
        >
          {source.name}
          {source.category && (
            <span className="ml-1.5 text-[10px] text-zinc-500">· {source.category}</span>
          )}
        </button>
      )}
      {!editing && (
        <RowMenu
          canCategory={source.kind === 'video'}
          onRename={() => { setNameDraft(source.name); setEditMode('name'); }}
          onCategory={() => { setCatDraft(source.category ?? ''); setEditMode('category'); }}
          onRemove={onRemove}
        />
      )}
    </div>
  );
}

/** Per-source kebab (⋮) menu — Rename / Category / Remove. Portaled to <body>
 *  and positioned at the button so the sidebar's overflow can't clip it. */
function RowMenu({
  canCategory, onRename, onCategory, onRemove,
}: {
  canCategory: boolean;
  onRename: () => void;
  onCategory: () => void;
  onRemove: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 180) });
  };
  const close = () => setPos(null);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pos]);

  const item = 'w-full text-left px-3 py-2 text-sm hover:bg-zinc-800 flex items-center gap-2.5';

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (pos ? close() : open())}
        onMouseDown={(e) => e.stopPropagation()}
        title="More actions"
        aria-label="More actions"
        className="text-zinc-600 hover:text-zinc-100 hover:bg-zinc-800 rounded px-1 py-1 shrink-0 transition"
      >
        <KebabIcon />
      </button>
      {pos && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[75]" onMouseDown={close} />
          <div
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-[76] w-44 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1"
          >
            <button className={`${item} text-zinc-200`} onClick={() => { close(); onRename(); }}>
              <PencilIcon /> Rename
            </button>
            {canCategory && (
              <button className={`${item} text-zinc-200`} onClick={() => { close(); onCategory(); }}>
                <FolderIcon /> Set category
              </button>
            )}
            <div className="border-t border-zinc-800 my-1" />
            <button className={`${item} text-red-300 hover:bg-red-950/40 hover:text-red-200`} onClick={() => { close(); onRemove(); }}>
              <TrashIcon /> Remove
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

function Row({ label, active, onClick, leading }: {
  label: string; active: boolean; onClick: () => void; leading: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 mx-1 py-2 rounded-md text-sm text-left
                  ${active ? 'bg-zinc-800/80 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'}`}
    >
      {leading}
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

/** Compact per-kind glyph — replaces the space-hungry "CHANNEL/VIDEO" text. */
function KindIcon({ kind }: { kind: ExternalSourceKind }) {
  const cls = 'shrink-0 text-zinc-500';
  if (kind === 'video') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" className={cls} aria-label="Video" role="img">
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === 'playlist') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" className={cls} aria-label="Playlist" role="img">
        <path d="M3 6h12M3 11h12M3 16h7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M16 13.5l5 2.5-5 2.5z" fill="currentColor" />
      </svg>
    );
  }
  // channel
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" className={cls} aria-label="Channel" role="img">
      <rect x="3" y="7.5" width="18" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 7.5l3.5-3.2M16 7.5l-3.5-3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M11 11.5l4 2.2-4 2.2z" fill="currentColor" />
    </svg>
  );
}

function BackChevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden>
      <g fill="currentColor">
        <circle cx="3" cy="4" r="1.1" /><circle cx="7" cy="4" r="1.1" />
        <circle cx="3" cy="8" r="1.1" /><circle cx="7" cy="8" r="1.1" />
        <circle cx="3" cy="12" r="1.1" /><circle cx="7" cy="12" r="1.1" />
      </g>
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4 20h4L18 10l-4-4L4 16z" strokeLinejoin="round" />
      <path d="M13 6l4 4" />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="8" cy="3" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="8" cy="13" r="1.4" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 12h10l1-12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" className="shrink-0 text-zinc-500" aria-hidden>
      <rect x="3" y="4" width="7" height="7" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="4" width="7" height="7" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3" y="15" width="7" height="5" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="15" width="7" height="5" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function YouTubeMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" className="shrink-0 text-red-500" aria-hidden>
      <path fill="currentColor" d="M23 12s0-3.8-.5-5.6a2.9 2.9 0 0 0-2-2C18.7 4 12 4 12 4s-6.7 0-8.5.4a2.9 2.9 0 0 0-2 2C1 8.2 1 12 1 12s0 3.8.5 5.6a2.9 2.9 0 0 0 2 2C5.3 20 12 20 12 20s6.7 0 8.5-.4a2.9 2.9 0 0 0 2-2C23 15.8 23 12 23 12z" />
      <path fill="#fff" d="M10 15.5v-7l6 3.5z" />
    </svg>
  );
}

export function AddSourceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (slug: string) => void }) {
  const utils = trpc.useUtils();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = trpc.externalSource.create.useMutation({
    onSuccess: (src) => { void utils.externalSource.list.invalidate(); onAdded(src.slug); },
    onError: (e) => setError(e.message),
  });

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-6"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); if (url.trim()) create.mutate({ url: url.trim() }); }}
        className="w-full max-w-md bg-zinc-900 ring-1 ring-zinc-800 rounded-xl p-5 flex flex-col gap-3 shadow-2xl"
      >
        <h2 className="text-base font-medium text-zinc-100">Add a YouTube source</h2>
        <p className="text-xs text-zinc-500">
          Paste a channel, playlist, or video link — e.g.{' '}
          <span className="text-zinc-400">youtube.com/@channel</span>,{' '}
          <span className="text-zinc-400">…/playlist?list=…</span>, or a{' '}
          <span className="text-zinc-400">youtu.be/…</span> video.
        </p>
        <input
          autoFocus
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          placeholder="https://www.youtube.com/@…"
          className="bg-zinc-950 border border-zinc-700 rounded-md px-3 py-2 text-sm outline-none focus:border-zinc-500"
        />
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            type="submit"
            disabled={create.isPending || !url.trim()}
            className="px-3 py-1.5 text-sm rounded-md bg-zinc-200 text-zinc-900 font-medium hover:bg-white disabled:opacity-40"
          >
            {create.isPending ? 'Adding…' : 'Add source'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
