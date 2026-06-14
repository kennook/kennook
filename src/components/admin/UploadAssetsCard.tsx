'use client';

/**
 * Admin upload card (mounted on /admin/storage). Pick a target library AND a
 * storage location — both required, no defaults, so a file can't silently land
 * in the wrong place — then drop or choose photos/videos. Each file POSTs to
 * /api/admin/upload, which saves it under <storage root>/Uploads/ and enqueues
 * an indexer job. Indexing progress shows in the Jobs panel; items appear in the
 * library once it's done.
 */

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';

type UploadStatus = 'uploading' | 'queued' | 'error';
interface UploadRow {
  id: string;
  name: string;
  status: UploadStatus;
  error?: string;
}

let counter = 0;

export function UploadAssetsCard() {
  const libraries = trpc.library.list.useQuery();
  const inputRef = useRef<HTMLInputElement>(null);

  // No defaults — the admin must deliberately choose the destination.
  const [librarySlug, setLibrarySlug] = useState<string | null>(null);
  const [storageId, setStorageId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadRow[]>([]);

  const storages = trpc.storage.list.useQuery(
    { librarySlug: librarySlug ?? undefined },
    { enabled: !!librarySlug },
  );
  // Only real (non catch-all) storages are valid targets — "/" is the FS root.
  const targets = (storages.data ?? []).filter((s) => s.root_path !== '/');

  // A storage choice only makes sense within a library — reset it on change.
  useEffect(() => { setStorageId(null); }, [librarySlug]);

  const ready = !!librarySlug && storageId != null;
  const targetName = targets.find((s) => s.id === storageId)?.name;

  async function uploadFiles(files: FileList | File[]) {
    if (!librarySlug || storageId == null) return;

    for (const file of Array.from(files)) {
      const id = `u${counter++}`;
      setUploads((u) => [{ id, name: file.name, status: 'uploading' }, ...u]);

      const form = new FormData();
      form.set('file', file);
      form.set('library', librarySlug);
      form.set('storageId', String(storageId));

      try {
        const res = await fetch('/api/admin/upload', { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: 'queued' } : x)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: 'error', error: msg } : x)));
      }
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-200">Upload media</h2>

      {/* Destination is a deliberate, required choice — no defaults. */}
      <div className="grid sm:grid-cols-2 gap-2">
        <label className="text-xs text-zinc-400">
          Library
          <select
            value={librarySlug ?? ''}
            onChange={(e) => setLibrarySlug(e.target.value || null)}
            className="mt-1 w-full bg-zinc-900 ring-1 ring-zinc-800 rounded px-2 py-1.5 text-xs
                       text-zinc-200 focus:ring-zinc-600 outline-none"
          >
            <option value="">Select a library…</option>
            {(libraries.data ?? []).map((l) => (
              <option key={l.slug} value={l.slug}>{l.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-zinc-400">
          Storage location
          <select
            value={storageId ?? ''}
            onChange={(e) => setStorageId(e.target.value ? Number(e.target.value) : null)}
            disabled={!librarySlug || targets.length === 0}
            className="mt-1 w-full bg-zinc-900 ring-1 ring-zinc-800 rounded px-2 py-1.5 text-xs
                       text-zinc-200 focus:ring-zinc-600 outline-none disabled:opacity-50"
          >
            <option value="">
              {!librarySlug ? 'Pick a library first…' : 'Select a storage location…'}
            </option>
            {targets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
      </div>

      {librarySlug && !storages.isLoading && targets.length === 0 && (
        <div className="text-[11px] text-amber-300/80 bg-amber-950/20 ring-1 ring-amber-900/40 rounded px-3 py-2">
          This library has no storage location to upload into. Add one in its Storage admin first.
        </div>
      )}

      {ready ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-8 text-center transition
            ${dragOver
              ? 'border-emerald-600 bg-emerald-950/20'
              : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/40'}`}
        >
          <div className="text-sm text-zinc-300">Drop photos or videos here, or click to choose</div>
          <div className="text-[11px] text-zinc-500 mt-1">
            Saved to <span className="font-mono">Uploads/</span> under{' '}
            <span className="text-zinc-400">{targetName}</span>, then indexed automatically.
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/*,video/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void uploadFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      ) : (
        <div className="rounded-lg border-2 border-dashed border-zinc-800 px-4 py-8 text-center
                        text-[11px] text-zinc-500 select-none">
          Choose a library and storage location above to enable uploads.
        </div>
      )}

      {uploads.length > 0 && (
        <ul className="space-y-1">
          {uploads.map((u) => (
            <li
              key={u.id}
              className="flex items-center justify-between gap-3 text-xs px-3 py-1.5 rounded
                         bg-zinc-900/50 ring-1 ring-zinc-800"
            >
              <span className="text-zinc-300 truncate">{u.name}</span>
              {u.status === 'uploading' && <span className="text-zinc-500 shrink-0">uploading…</span>}
              {u.status === 'queued' && <span className="text-emerald-300 shrink-0">queued for indexing</span>}
              {u.status === 'error' && (
                <span className="text-red-300 shrink-0" title={u.error}>failed</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {uploads.some((u) => u.status === 'queued') && (
        <p className="text-[11px] text-zinc-500">
          Indexing runs in the background — watch progress in Jobs below. New items appear in your
          library once indexing finishes.
        </p>
      )}
    </div>
  );
}
