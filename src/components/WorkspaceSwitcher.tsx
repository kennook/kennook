'use client';

import { useState, useRef, useEffect } from 'react';
import { trpc } from '@/lib/trpc-client';
import { usePageState } from '@/lib/url-state';

// Skip the initial mount so we don't invalidate every query on every
// page load. Subsequent changes to url.workspace — whether from a
// dropdown pick or a cross-tab sync — are real switches that should
// trigger refetches.
const INITIAL_PREV = Symbol('initial');

const COOKIE_NAME = 'kennook_workspace';

function setWorkspaceCookie(slug: string) {
  // 400 days is the max chrome will honor; that's plenty. The cookie is
  // now a fallback for first-load visitors; URL state is the primary
  // source of truth per-tab.
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(slug)}; path=/; max-age=${60 * 60 * 24 * 400}; samesite=lax`;
}

export function WorkspaceSwitcher() {
  const url = usePageState();
  const workspaces = trpc.workspace.list.useQuery();
  const current = trpc.workspace.current.useQuery();
  const utils = trpc.useUtils();
  const createMutation = trpc.workspace.create.useMutation({
    onSuccess: (ws) => {
      setWorkspaceCookie(ws.slug);
      url.set({ workspace: ws.slug });
      utils.invalidate();
    },
  });

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Anchor this tab's workspace into the URL on first load. Tabs that
  // open without `?ws=` initially resolve their workspace from the shared
  // cookie; writing it back to the URL means subsequent reloads in THIS
  // tab can't get hijacked if another tab flips workspaces in between.
  // `preservePage: true` keeps deep-linked page numbers intact.
  useEffect(() => {
    if (!url.workspace && current.data?.slug) {
      url.set({ workspace: current.data.slug }, { preservePage: true });
    }
    // Run only when the resolved workspace changes (or when URL drops it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.data?.slug, url.workspace]);

  const switchTo = (slug: string) => {
    setWorkspaceCookie(slug);
    // URL update drives every subsequent request's workspace header.
    // Once it's in the URL, this tab is anchored — refreshing won't get
    // hijacked by another tab's cookie write. We deliberately DON'T
    // invalidate here: router.replace runs in startTransition, so
    // window.location lags one render behind, and any refetch fired
    // synchronously would still carry the old `x-kennook-workspace`
    // header. The effect below catches the URL change AFTER it commits.
    //
    // Clear ALL filters + viewer state on switch — items in the new
    // workspace almost never overlap with the previous one's filters
    // (different people, different tags, different cameras, etc.), so
    // carrying them over leads to mysterious empty-result screens.
    // The viewer's item/view also clear since the open item isn't in
    // the new workspace.
    url.set({
      workspace: slug,
      query: '',
      similar: null,
      playlist: null,
      person: null,
      kind: null,
      orientation: null,
      cameraMake: null,
      year: null,
      tags: [],
      minLikes: null,
      watched: null,
      sensitive: null,
      item: null,
      view: null,
    });
    setOpen(false);
  };

  // Cross-cuts dropdown picks (this tab), cookie back-fills on first
  // load (anchor effect above), and cross-tab syncs via the URL state.
  // Once url.workspace has actually changed in the DOM, invalidate every
  // cached query so the next request uses the new header.
  const prevWorkspaceRef = useRef<string | null | typeof INITIAL_PREV>(INITIAL_PREV);
  useEffect(() => {
    if (prevWorkspaceRef.current === INITIAL_PREV) {
      prevWorkspaceRef.current = url.workspace;
      return;
    }
    if (prevWorkspaceRef.current === url.workspace) return;
    prevWorkspaceRef.current = url.workspace;
    utils.invalidate();
  }, [url.workspace, utils]);

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (newName.trim()) createMutation.mutate({ name: newName.trim() });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 bg-zinc-900/80 border border-zinc-800
                   hover:border-zinc-700 rounded-lg px-3 py-1.5 text-sm transition"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        <span className="text-zinc-200">{current.data?.name ?? '…'}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-500">
          <path d="M1 3 L5 7 L9 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-64 bg-zinc-900 border border-zinc-800
                        rounded-lg shadow-xl py-1 z-20">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            Workspaces
          </div>
          {workspaces.data?.map((ws) => {
            const isCurrent = ws.slug === current.data?.slug;
            return (
              <button
                key={ws.slug}
                onClick={() => !isCurrent && switchTo(ws.slug)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between
                            hover:bg-zinc-800 ${isCurrent ? 'text-zinc-100' : 'text-zinc-300'}`}
              >
                <span>{ws.name}</span>
                {isCurrent && (
                  <span className="text-emerald-400 text-xs">active</span>
                )}
              </button>
            );
          })}

          <div className="border-t border-zinc-800 my-1" />

          {!creating ? (
            <button
              onClick={() => setCreating(true)}
              className="w-full text-left px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              + New workspace…
            </button>
          ) : (
            <form onSubmit={submitCreate} className="px-3 py-2">
              <input
                autoFocus
                type="text"
                placeholder="Workspace name (e.g., Work)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm
                           focus:border-zinc-600 outline-none"
              />
              <div className="flex gap-2 mt-2">
                <button
                  type="submit"
                  disabled={createMutation.isPending || !newName.trim()}
                  className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50
                             disabled:cursor-not-allowed text-sm rounded py-1"
                >
                  {createMutation.isPending ? 'Creating…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName(''); }}
                  className="text-sm px-2 text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
              {createMutation.error && (
                <div className="mt-2 text-xs text-red-400">
                  {createMutation.error.message}
                </div>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
