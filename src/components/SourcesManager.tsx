'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { trpc } from '@/lib/trpc-client';
import type { ExternalSourceKind } from '@/server/external-sources';

interface Source {
  slug: string;
  name: string;
  kind: ExternalSourceKind;
}

interface Props {
  activeSourceSlug: string | null;
  onSelectSource: (slug: string | null) => void;
  /** Close the panel and return to the main sidebar content. */
  onBack: () => void;
}

/**
 * In-sidebar manager for external (YouTube) sources — a second layer that the
 * parent slides over the sidebar column (no backdrop, so it can't be dismissed
 * by clicking away; the "‹ Back" header returns to the main sidebar). Add,
 * filter, drag-to-reorder, inline-rename, and delete, with room for full titles.
 */
export function SourcesManager({ activeSourceSlug, onSelectSource, onBack }: Props) {
  const utils = trpc.useUtils();
  const sources = trpc.externalSource.list.useQuery();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  // Local working order — the source of truth for drag-reorder. Resynced from
  // the server only when the SET of slugs changes (add/remove), so an in-session
  // reorder isn't clobbered by the refetch our own mutation triggers.
  const [items, setItems] = useState<Source[]>([]);
  useEffect(() => {
    const incoming = (sources.data ?? []).map((s) => ({ slug: s.slug, name: s.name, kind: s.kind }));
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((s) => s.name.toLowerCase().includes(q)) : items;
  }, [items, query]);
  const canReorder = query.trim() === '';

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

  // Picking a source switches the grid AND closes the panel (you're done here).
  const pick = (slug: string | null) => { onSelectSource(slug); onBack(); };

  return (
    <div className="flex flex-col pr-2">
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

      <div className="flex flex-col">
        <Row
          label="Back to library"
          active={activeSourceSlug === null}
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
  onDragStart, onDragOver, onDrop, onDragEnd, onOpen, onRename, onRemove,
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
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source.name);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== source.name) onRename(v);
    setEditing(false);
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
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setDraft(source.name); setEditing(false); }
          }}
          onBlur={commit}
          className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1 my-1 text-sm outline-none focus:border-zinc-500"
        />
      ) : (
        <button
          onClick={onOpen}
          onDoubleClick={() => { setDraft(source.name); setEditing(true); }}
          title={source.name}
          className={`flex-1 min-w-0 text-left py-2 text-sm truncate ${active ? 'text-zinc-100' : 'text-zinc-300'}`}
        >
          {source.name}
        </button>
      )}
      <button
        onClick={() => { setDraft(source.name); setEditing(true); }}
        title="Rename"
        className="text-zinc-600 hover:text-zinc-200 opacity-0 group-hover:opacity-100 px-0.5 shrink-0"
      >
        <PencilIcon />
      </button>
      <button
        onClick={onRemove}
        title="Remove source"
        className="text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 px-1 text-base leading-none shrink-0"
      >
        ×
      </button>
    </div>
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
