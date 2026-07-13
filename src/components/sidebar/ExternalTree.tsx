'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { trpc } from '@/lib/trpc-client';
import { AddSourceDialog } from '@/components/SourcesManager';
import type { ExternalSourceKind } from '@/server/external-sources';
import { PanelHeader } from './ProfilePanel';

interface Src { slug: string; name: string; kind: ExternalSourceKind; category?: string }

interface Props {
  activeSourceSlug: string | null;
  activeCategory: string | null;
  onSelectSource: (slug: string | null) => void;
  onSelectCategory: (category: string | null) => void;
}

/**
 * Level-2 "External sources" panel — a drag/drop tree. Single-video/live sources
 * are grouped under user categories (drag one onto a category to file it, or onto
 * another source to reorder); playlists and channels get their own fixed groups
 * (they carry their own video lists, so they aren't categorized). Categories are
 * derived from the sources' `category`; a freshly-created empty one is held
 * locally until you drag a source into it.
 */
export function ExternalTree({ activeSourceSlug, activeCategory, onSelectSource, onSelectCategory }: Props) {
  const utils = trpc.useUtils();
  const q = trpc.externalSource.list.useQuery();

  // Local working copy (source of truth for optimistic drag). Resynced only when
  // the SET of slugs changes, so a reorder isn't clobbered by our own refetch.
  const [items, setItems] = useState<Src[]>([]);
  useEffect(() => {
    const incoming = (q.data ?? []).map((s) => ({ slug: s.slug, name: s.name, kind: s.kind, category: s.category }));
    setItems((prev) => {
      const same = prev.length === incoming.length && prev.every((p) => incoming.some((i) => i.slug === p.slug));
      return same ? prev.map((p) => incoming.find((i) => i.slug === p.slug) ?? p) : incoming;
    });
  }, [q.data]);

  // Any structural change also invalidates the category grid (categoryItems), or
  // a viewed category would show a stale/merged set from an earlier fetch.
  const refresh = () => {
    void utils.externalSource.list.invalidate();
    void utils.externalSource.categoryItems.invalidate();
  };
  const move = trpc.externalSource.move.useMutation({ onSuccess: refresh });
  const remove = trpc.externalSource.remove.useMutation({
    onSuccess: (_d, v) => { refresh(); if (v.slug === activeSourceSlug) onSelectSource(null); },
  });
  const rename = trpc.externalSource.rename.useMutation({ onSuccess: refresh });
  const renameCat = trpc.externalSource.renameCategory.useMutation({ onSuccess: refresh });
  const deleteCat = trpc.externalSource.deleteCategory.useMutation({ onSuccess: refresh });

  const [adding, setAdding] = useState(false);
  const [pendingCats, setPendingCats] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const videos = items.filter((s) => s.kind === 'video');
  const playlists = items.filter((s) => s.kind === 'playlist');
  const channels = items.filter((s) => s.kind === 'channel');

  // Category names, in first-appearance order, plus locally-created empty ones.
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const v of videos) if (v.category && !seen.includes(v.category)) seen.push(v.category);
    for (const c of pendingCats) if (!seen.includes(c)) seen.push(c);
    return seen;
  }, [videos, pendingCats]);
  const uncategorized = videos.filter((v) => !v.category);

  const isColl = (k: string) => collapsed.has(k);
  const toggle = (k: string) => setCollapsed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // Apply a move locally (optimistic) + persist.
  const applyMove = (slug: string, category: string | null, beforeSlug: string | null) => {
    setItems((prev) => {
      const next = [...prev];
      const i = next.findIndex((s) => s.slug === slug);
      if (i < 0) return prev;
      const [moved] = next.splice(i, 1);
      moved.category = category ?? undefined;
      const j = beforeSlug ? next.findIndex((s) => s.slug === beforeSlug) : -1;
      if (j >= 0) next.splice(j, 0, moved); else next.push(moved);
      return next;
    });
    move.mutate({ slug, category, beforeSlug });
    setDragSlug(null); setOverKey(null);
  };

  // Drop a dragged video source into a category (top of its group).
  const dropInCategory = (category: string | null) => {
    if (!dragSlug) return;
    const first = videos.find((v) => (v.category ?? '') === (category ?? '') && v.slug !== dragSlug);
    applyMove(dragSlug, category, first?.slug ?? null);
  };
  // Drop a dragged video source before another source (adopt its category).
  const dropBefore = (target: Src) => {
    if (!dragSlug || dragSlug === target.slug) { setDragSlug(null); setOverKey(null); return; }
    applyMove(dragSlug, target.category ?? null, target.slug);
  };

  const addCategory = () => {
    const name = window.prompt('New category name (e.g. news, music)')?.trim();
    if (name && !categories.includes(name)) setPendingCats((p) => [...p, name]);
  };

  return (
    <div className="flex flex-col">
      <PanelHeader title="External sources" />

      <div className="px-1.5 flex gap-1.5 mb-2">
        <button onClick={() => setAdding(true)}
          className="flex-1 rounded-md bg-zinc-200 text-zinc-900 text-sm font-medium py-1.5 hover:bg-white transition">
          + Add source
        </button>
        <button onClick={addCategory} title="New category"
          className="rounded-md border border-zinc-700 text-zinc-300 text-sm px-2.5 hover:bg-zinc-800 transition">
          + Category
        </button>
      </div>

      <button
        onClick={() => onSelectSource(null)}
        className={`flex items-center gap-2 px-3 mx-1 py-2 rounded-md text-sm text-left
                    ${activeSourceSlug === null && activeCategory === null ? 'bg-zinc-800/80 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'}`}
      >
        <LibraryGlyph /> Back to library
      </button>

      <div className="mt-1">
        {/* User categories */}
        {categories.map((cat) => {
          const members = videos.filter((v) => v.category === cat);
          const key = `cat:${cat}`;
          return (
            <div key={key}>
              <GroupHeader
                label={cat}
                count={members.length}
                collapsed={isColl(key)}
                active={activeCategory === cat}
                dragOver={overKey === key}
                onToggle={() => toggle(key)}
                onOpen={() => onSelectCategory(cat)}
                onDragOver={dragSlug ? () => setOverKey(key) : undefined}
                onDrop={dragSlug ? () => dropInCategory(cat) : undefined}
                menu={
                  <GroupMenu
                    onRename={() => { const t = window.prompt('Rename category', cat)?.trim(); if (t && t !== cat) { setPendingCats((p) => p.map((c) => c === cat ? t : c)); renameCat.mutate({ from: cat, to: t }); if (activeCategory === cat) onSelectCategory(t); } }}
                    onDelete={() => { setPendingCats((p) => p.filter((c) => c !== cat)); deleteCat.mutate({ name: cat }); if (activeCategory === cat) onSelectCategory(null); }}
                  />
                }
              />
              {!isColl(key) && members.map((s) => (
                <SourceRow key={s.slug} src={s} depth active={s.slug === activeSourceSlug}
                  dragging={dragSlug === s.slug} dragOver={overKey === `src:${s.slug}`}
                  onDragStart={() => setDragSlug(s.slug)} onDragEnd={() => { setDragSlug(null); setOverKey(null); }}
                  onDragOver={dragSlug ? () => setOverKey(`src:${s.slug}`) : undefined} onDrop={dragSlug ? () => dropBefore(s) : undefined}
                  onOpen={() => onSelectSource(s.slug)} onRename={(n) => rename.mutate({ slug: s.slug, name: n })}
                  onRemove={() => remove.mutate({ slug: s.slug })} />
              ))}
            </div>
          );
        })}

        {/* Uncategorized live sources */}
        {uncategorized.length > 0 && (
          <div>
            <GroupHeader label="Uncategorized" count={uncategorized.length} collapsed={isColl('unc')} muted
              dragOver={overKey === 'unc'} onToggle={() => toggle('unc')}
              onDragOver={dragSlug ? () => setOverKey('unc') : undefined} onDrop={dragSlug ? () => dropInCategory(null) : undefined} />
            {!isColl('unc') && uncategorized.map((s) => (
              <SourceRow key={s.slug} src={s} depth active={s.slug === activeSourceSlug}
                dragging={dragSlug === s.slug} dragOver={overKey === `src:${s.slug}`}
                onDragStart={() => setDragSlug(s.slug)} onDragEnd={() => { setDragSlug(null); setOverKey(null); }}
                onDragOver={dragSlug ? () => setOverKey(`src:${s.slug}`) : undefined} onDrop={dragSlug ? () => dropBefore(s) : undefined}
                onOpen={() => onSelectSource(s.slug)} onRename={(n) => rename.mutate({ slug: s.slug, name: n })}
                onRemove={() => remove.mutate({ slug: s.slug })} />
            ))}
          </div>
        )}

        {/* Fixed groups: playlists + channels (not categorized). */}
        {playlists.length > 0 && (
          <FixedGroup label="Playlists" k="pl" collapsed={isColl('pl')} onToggle={() => toggle('pl')}
            sources={playlists} activeSourceSlug={activeSourceSlug} onSelectSource={onSelectSource}
            onRename={rename} onRemove={remove} />
        )}
        {channels.length > 0 && (
          <FixedGroup label="Channels" k="ch" collapsed={isColl('ch')} onToggle={() => toggle('ch')}
            sources={channels} activeSourceSlug={activeSourceSlug} onSelectSource={onSelectSource}
            onRename={rename} onRemove={remove} />
        )}

        {items.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-zinc-600">No sources yet — add one above.</div>
        )}
      </div>

      {adding && <AddSourceDialog onClose={() => setAdding(false)} onAdded={(slug) => { setAdding(false); onSelectSource(slug); }} />}
    </div>
  );
}

function FixedGroup({ label, k, collapsed, onToggle, sources, activeSourceSlug, onSelectSource, onRename, onRemove }: {
  label: string; k: string; collapsed: boolean; onToggle: () => void; sources: Src[];
  activeSourceSlug: string | null; onSelectSource: (s: string | null) => void;
  onRename: { mutate: (v: { slug: string; name: string }) => void };
  onRemove: { mutate: (v: { slug: string }) => void };
}) {
  return (
    <div>
      <GroupHeader label={label} count={sources.length} collapsed={collapsed} muted onToggle={onToggle} />
      {!collapsed && sources.map((s) => (
        <SourceRow key={s.slug} src={s} depth active={s.slug === activeSourceSlug}
          onOpen={() => onSelectSource(s.slug)} onRename={(n) => onRename.mutate({ slug: s.slug, name: n })}
          onRemove={() => onRemove.mutate({ slug: s.slug })} />
      ))}
    </div>
  );
}

function GroupHeader({ label, count, collapsed, active, muted, dragOver, onToggle, onOpen, onDragOver, onDrop, menu }: {
  label: string; count: number; collapsed: boolean; active?: boolean; muted?: boolean; dragOver?: boolean;
  onToggle: () => void; onOpen?: () => void; onDragOver?: () => void; onDrop?: () => void; menu?: React.ReactNode;
}) {
  return (
    <div
      onDragOver={onDragOver ? (e) => { e.preventDefault(); onDragOver(); } : undefined}
      onDrop={onDrop ? (e) => { e.preventDefault(); onDrop(); } : undefined}
      className={`group/hdr flex items-center gap-1 pl-1.5 pr-1 mx-1 rounded-md
                  ${dragOver ? 'ring-1 ring-inset ring-sky-500/70 bg-sky-500/10' : ''}`}
    >
      <button onClick={onToggle} className="text-zinc-600 hover:text-zinc-300 grid place-items-center w-4 h-6 shrink-0">
        <span className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}><CaretIcon /></span>
      </button>
      <button
        onClick={onOpen ?? onToggle}
        className={`flex-1 min-w-0 text-left py-1.5 text-[11px] uppercase tracking-wider truncate
                    ${active ? 'text-sky-300' : muted ? 'text-zinc-600' : 'text-zinc-400'}`}
      >
        {label} <span className="text-zinc-600 normal-case">· {count}</span>
      </button>
      {menu}
    </div>
  );
}

function SourceRow({ src, depth, active, dragging, dragOver, onDragStart, onDragEnd, onDragOver, onDrop, onOpen, onRename, onRemove }: {
  src: Src; depth?: boolean; active: boolean; dragging?: boolean; dragOver?: boolean;
  onDragStart?: () => void; onDragEnd?: () => void; onDragOver?: () => void; onDrop?: () => void;
  onOpen: () => void; onRename: (n: string) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(src.name);
  const draggable = !!onDragStart && !editing;
  return (
    <div
      draggable={draggable}
      onDragStart={draggable ? (e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart!(); } : undefined}
      onDragOver={onDragOver ? (e) => { e.preventDefault(); onDragOver(); } : undefined}
      onDrop={onDrop ? (e) => { e.preventDefault(); onDrop(); } : undefined}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-1 pr-1 mx-1 rounded-md ${depth ? 'pl-5' : 'pl-1.5'}
                  ${active ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}
                  ${dragging ? 'opacity-40' : ''} ${dragOver ? 'ring-1 ring-inset ring-sky-500/60' : ''}`}
    >
      {draggable && <span className="text-zinc-700 group-hover:text-zinc-500 cursor-grab active:cursor-grabbing shrink-0"><GripIcon /></span>}
      <span className="w-1.5 h-1.5 rounded-full bg-red-500/80 shrink-0" />
      {editing ? (
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { const v = draft.trim(); if (v && v !== src.name) onRename(v); setEditing(false); } else if (e.key === 'Escape') { setDraft(src.name); setEditing(false); } }}
          onBlur={() => { const v = draft.trim(); if (v && v !== src.name) onRename(v); setEditing(false); }}
          className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1 my-1 text-sm outline-none focus:border-zinc-500" />
      ) : (
        <button onClick={onOpen} onDoubleClick={() => { setDraft(src.name); setEditing(true); }} title={src.name}
          className={`flex-1 min-w-0 text-left py-1.5 text-sm truncate ${active ? 'text-zinc-100' : 'text-zinc-300'}`}>
          {src.name}
        </button>
      )}
      {!editing && <RowMenu onRename={() => { setDraft(src.name); setEditing(true); }} onRemove={onRemove} />}
    </div>
  );
}

// Small portaled menu (reused shape from SourcesManager).
function RowMenu({ onRename, onRemove }: { onRename: () => void; onRemove: () => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  return (
    <>
      <button
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 160) }); }}
        onMouseDown={(e) => e.stopPropagation()}
        title="More" className="text-zinc-600 hover:text-zinc-100 hover:bg-zinc-800 rounded px-1 py-1 shrink-0 opacity-0 group-hover:opacity-100 transition">
        <KebabIcon />
      </button>
      {pos && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[75]" onMouseDown={() => setPos(null)} />
          <div style={{ top: pos.top, left: pos.left }} className="fixed z-[76] w-40 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1">
            <button className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800" onClick={() => { setPos(null); onRename(); }}>Rename</button>
            <div className="border-t border-zinc-800 my-1" />
            <button className="w-full text-left px-3 py-2 text-sm text-red-300 hover:bg-red-950/40" onClick={() => { setPos(null); onRemove(); }}>Remove</button>
          </div>
        </>, document.body)}
    </>
  );
}

function GroupMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  return (
    <>
      <button
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 160) }); }}
        title="Category actions" className="text-zinc-600 hover:text-zinc-100 hover:bg-zinc-800 rounded px-1 py-1 shrink-0 opacity-0 group-hover/hdr:opacity-100 transition">
        <KebabIcon />
      </button>
      {pos && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[75]" onMouseDown={() => setPos(null)} />
          <div style={{ top: pos.top, left: pos.left }} className="fixed z-[76] w-40 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1">
            <button className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800" onClick={() => { setPos(null); onRename(); }}>Rename category</button>
            <div className="border-t border-zinc-800 my-1" />
            <button className="w-full text-left px-3 py-2 text-sm text-red-300 hover:bg-red-950/40" onClick={() => { setPos(null); onDelete(); }}>Delete category</button>
          </div>
        </>, document.body)}
    </>
  );
}

function CaretIcon() { return (<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M2 3l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" /></svg>); }
function GripIcon() { return (<svg width="9" height="14" viewBox="0 0 10 16" aria-hidden><g fill="currentColor"><circle cx="3" cy="4" r="1" /><circle cx="7" cy="4" r="1" /><circle cx="3" cy="8" r="1" /><circle cx="7" cy="8" r="1" /><circle cx="3" cy="12" r="1" /><circle cx="7" cy="12" r="1" /></g></svg>); }
function KebabIcon() { return (<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden><circle cx="8" cy="3" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="8" cy="13" r="1.3" /></svg>); }
function LibraryGlyph() { return (<svg width="15" height="15" viewBox="0 0 24 24" className="shrink-0 text-zinc-500" aria-hidden><rect x="3" y="4" width="7" height="7" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" /><rect x="14" y="4" width="7" height="7" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" /><rect x="3" y="15" width="7" height="5" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" /><rect x="14" y="15" width="7" height="5" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>); }
