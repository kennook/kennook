'use client';

/**
 * Sidebar section for per-user saved searches (query + filters + sort). Saving
 * captures the current saveable state; clicking one re-applies it (and clears
 * any playlist/person/similar view-mode context so the search actually shows).
 * Scoped to the active library.
 */

import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { usePageState, type PageState } from '@/lib/url-state';

// The saveable subset — mirrors the server's `savedSearchPayload` schema.
interface SearchPayload {
  query?: string;
  kind?: string | null;
  orientation?: string | null;
  quality?: string | null;
  cameraMake?: string | null;
  storage?: number | null;
  year?: number | null;
  tags?: string[];
  mentioned?: string[];
  minLikes?: number | null;
  watched?: string | null;
  sensitive?: string | null;
  sort?: string | null;
}

export function SavedSearchesSection() {
  const url = usePageState();
  const utils = trpc.useUtils();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  // The saved search last applied — highlighted, and the obvious "update" target.
  const [activeUuid, setActiveUuid] = useState<string | null>(null);

  const list = trpc.savedSearch.list.useQuery({ librarySlug: url.library ?? undefined });

  const create = trpc.savedSearch.create.useMutation({
    onSuccess: (res) => {
      utils.savedSearch.list.invalidate();
      setSaving(false); setName(''); setActiveUuid(res.uuid);
    },
  });
  const update = trpc.savedSearch.update.useMutation({
    onSuccess: () => utils.savedSearch.list.invalidate(),
  });
  const remove = trpc.savedSearch.delete.useMutation({
    onSuccess: () => utils.savedSearch.list.invalidate(),
  });

  // Current search → the saveable payload (only non-empty keys).
  const payload = useMemo<SearchPayload>(() => {
    const p: SearchPayload = {};
    if (url.query) p.query = url.query;
    if (url.kind != null) p.kind = url.kind;
    if (url.orientation != null) p.orientation = url.orientation;
    if (url.quality != null) p.quality = url.quality;
    if (url.cameraMake != null) p.cameraMake = url.cameraMake;
    if (url.storage != null) p.storage = url.storage;
    if (url.year != null) p.year = url.year;
    if (url.tags.length) p.tags = url.tags;
    if (url.mentioned.length) p.mentioned = url.mentioned;
    if (url.minLikes != null) p.minLikes = url.minLikes;
    if (url.watched != null) p.watched = url.watched;
    if (url.sensitive != null) p.sensitive = url.sensitive;
    if (url.sort != null) p.sort = url.sort;
    return p;
  }, [
    url.query, url.kind, url.orientation, url.quality, url.cameraMake, url.storage,
    url.year, url.tags, url.mentioned, url.minLikes, url.watched, url.sensitive, url.sort,
  ]);

  const hasSaveableState = Object.keys(payload).length > 0;

  // Restore: reset ALL saveable keys (so filters not in the saved search are
  // cleared), then overlay the saved ones, and drop view-mode context.
  const apply = (search: Record<string, unknown>) => {
    url.set({
      query: '', kind: null, orientation: null, quality: null, cameraMake: null,
      storage: null, year: null, tags: [], mentioned: [], minLikes: null,
      watched: null, sensitive: null, sort: null,
      similar: null, playlist: null, person: null,
      ...(search as Partial<PageState>),
    });
  };

  const submitSave = () => {
    if (!name.trim() || !hasSaveableState) return;
    create.mutate({ name: name.trim(), librarySlug: url.library ?? undefined, search: payload });
  };

  return (
    <section className="mb-5">
      <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 px-3 mb-1.5
                     flex items-center justify-between">
        <span>Saved searches</span>
        {hasSaveableState && !saving && (
          <button
            onClick={() => setSaving(true)}
            className="text-zinc-500 hover:text-zinc-300 normal-case tracking-normal text-xs lowercase"
          >
            save current
          </button>
        )}
      </h3>

      {saving && (
        <form
          onSubmit={(e) => { e.preventDefault(); submitSave(); }}
          className="px-3 pb-2 flex gap-1.5"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this search"
            className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs
                       focus:border-zinc-600 outline-none"
          />
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="text-xs px-2 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => { setSaving(false); setName(''); }}
            className="text-xs px-1 text-zinc-500 hover:text-zinc-300"
            aria-label="Cancel"
          >
            ×
          </button>
        </form>
      )}

      {list.data?.length === 0 && !saving && (
        <div className="px-3 py-1.5 text-xs text-zinc-600 leading-relaxed">
          Run a search or set filters, then “save current”.
        </div>
      )}

      <div className="flex flex-col">
        {list.data?.map((s) => {
          const active = s.uuid === activeUuid;
          return (
            <div
              key={s.uuid}
              className={`group w-full flex items-center gap-2 px-3 py-1.5 rounded text-sm transition
                          ${active
                            ? 'bg-zinc-800/80 text-zinc-100'
                            : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60'}`}
            >
              <button
                onClick={() => { apply(s.search); setActiveUuid(s.uuid); }}
                className="flex-1 min-w-0 text-left flex items-center gap-2.5"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
                <span className="truncate">{s.name}</span>
              </button>
              {hasSaveableState && (
                <button
                  onClick={() => update.mutate({ uuid: s.uuid, search: payload })}
                  disabled={update.isPending}
                  title="Update with the current search"
                  aria-label="Update with the current search"
                  className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-emerald-300
                             shrink-0 transition disabled:opacity-40"
                >
                  <UpdateIcon />
                </button>
              )}
              <button
                onClick={() => remove.mutate({ uuid: s.uuid })}
                title="Delete saved search"
                aria-label="Delete saved search"
                className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-300
                           shrink-0 transition"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function UpdateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5H10.5" />
    </svg>
  );
}
