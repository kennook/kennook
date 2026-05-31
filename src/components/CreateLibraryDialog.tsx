'use client';

/**
 * Modal for creating a new library. Requires BOTH a name and an initial
 * storage root path — we no longer seed a "/" catch-all on the user's
 * behalf, so a library needs at least one configured folder before it
 * can do anything useful.
 *
 * Live server-side existence/directory probe on the path input so the
 * user gets feedback before submit.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';

interface Props {
  onCancel: () => void;
  /** Called with the new library's slug after a successful create. */
  onCreated: (slug: string) => void;
}

export function CreateLibraryDialog({ onCancel, onCreated }: Props) {
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const probe = trpc.storage.testPath.useQuery(
    { path: rootPath },
    { enabled: rootPath.length > 1 && rootPath.startsWith('/'), retry: false },
  );

  const create = trpc.library.create.useMutation();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!rootPath.trim()) { setError('Root path is required.'); return; }
    try {
      const lib = await create.mutateAsync({
        name: name.trim(),
        root_path: rootPath.trim(),
      });
      onCreated(lib.slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const probeStatus = (() => {
    if (!rootPath.startsWith('/')) return { tone: 'muted', label: 'Path should be absolute (start with /)' };
    if (probe.isLoading) return { tone: 'muted', label: 'Checking…' };
    if (probe.error) return { tone: 'error', label: probe.error.message };
    if (!probe.data) return null;
    if (!probe.data.exists) return { tone: 'error', label: 'Path does not exist' };
    if (!probe.data.isDirectory) return { tone: 'error', label: 'Path is not a directory' };
    return { tone: 'ok', label: 'Directory exists' };
  })();

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <form
        onSubmit={submit}
        className="bg-zinc-900 ring-1 ring-zinc-800 rounded-xl shadow-2xl w-full max-w-md p-6"
      >
        <h2 className="text-base font-medium text-zinc-100 mb-1">New library</h2>
        <p className="text-xs text-zinc-400 leading-relaxed mb-5">
          Each library is its own collection of media, with its own index.
          Pick a name and the folder where its files live — you can add more
          folders from Storage admin later.
        </p>

        <div className="space-y-3 mb-5">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Work"
              autoFocus
              className="w-full bg-zinc-950 ring-1 ring-zinc-800 focus:ring-zinc-600
                         rounded px-3 py-2 text-sm text-zinc-100 outline-none transition"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Initial root path</label>
            <input
              type="text"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="/Volumes/Work/Media"
              className="w-full bg-zinc-950 ring-1 ring-zinc-800 focus:ring-zinc-600
                         rounded px-3 py-2 text-sm text-zinc-100 outline-none transition
                         font-mono"
            />
            {probeStatus && (
              <div className={`text-[11px] mt-1.5 ${
                probeStatus.tone === 'ok' ? 'text-emerald-300'
                  : probeStatus.tone === 'error' ? 'text-amber-300'
                  : 'text-zinc-500'
              }`}>
                {probeStatus.label}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="text-[11px] text-amber-300 bg-amber-950/30 ring-1 ring-amber-900/40
                          rounded px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="px-4 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 rounded
                       text-emerald-50 transition disabled:opacity-50
                       disabled:cursor-not-allowed"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
