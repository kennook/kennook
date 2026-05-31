'use client';

/**
 * Modal for relocating an existing storage_location. Two-step flow:
 *   1. User enters a new root path → we run a dry-run that picks N random
 *      files from this storage and stats them at the proposed new root.
 *   2. UI shows existence results for the sample. User confirms → we call
 *      setRoot to commit. media_items.path values stay untouched because
 *      they're already stored relative to root_path.
 *
 * The relocate operation is O(1) at the DB level (one row update). The cost
 * is only the sample stat calls during verification.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import type { StorageInfo } from '@/server/storage';

interface Props {
  storage: StorageInfo;
  onCancel: () => void;
  onRelocated: () => void;
}

export function RelocateDialog({ storage, onCancel, onRelocated }: Props) {
  const [newRoot, setNewRoot] = useState('');
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Verification only fires after the user clicks "Verify" — keep the
  // dry-run explicit so we don't fs.stat the user's filesystem on every
  // keystroke.
  const verify = trpc.storage.verifyRelocation.useQuery(
    { id: storage.id, new_root_path: newRoot, sample_size: 5 },
    { enabled: verified, retry: false },
  );

  const apply = trpc.storage.setRoot.useMutation();

  const handleVerify = () => {
    setError(null);
    if (!newRoot.trim()) { setError('Enter a new root path.'); return; }
    if (!newRoot.startsWith('/')) { setError('Root path must be absolute (start with /).'); return; }
    setVerified(true);
  };

  const handleApply = async () => {
    setError(null);
    try {
      await apply.mutateAsync({ id: storage.id, new_root_path: newRoot.trim() });
      onRelocated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const result = verify.data;
  const someSamplesMissing = !!(result && result.samples.length > 0 && !result.all_samples_present);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="bg-zinc-900 ring-1 ring-zinc-800 rounded-xl shadow-2xl w-full max-w-lg p-6">
        <h2 className="text-base font-medium text-zinc-100 mb-1">
          Relocate &ldquo;{storage.name}&rdquo;
        </h2>
        <p className="text-xs text-zinc-400 leading-relaxed mb-4">
          Tell KenNook where this storage&apos;s files live now. We&apos;ll spot-check a
          handful of files at the new location before committing — your{' '}
          <span className="font-mono">{storage.file_count.toLocaleString()}</span> indexed{' '}
          item{storage.file_count === 1 ? '' : 's'} stay attached either way.
        </p>

        <div className="space-y-3 mb-5">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Current root</label>
            <div className="font-mono text-xs text-zinc-300 break-all bg-zinc-950 ring-1 ring-zinc-800
                            rounded px-3 py-2">
              {storage.root_path}
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">New root</label>
            <input
              type="text"
              value={newRoot}
              onChange={(e) => { setNewRoot(e.target.value); setVerified(false); }}
              placeholder="/Volumes/NewDrive/Photos"
              autoFocus
              className="w-full bg-zinc-950 ring-1 ring-zinc-800 focus:ring-zinc-600
                         rounded px-3 py-2 text-sm text-zinc-100 outline-none transition
                         font-mono"
            />
          </div>
        </div>

        {!verified && (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleVerify}
              className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 rounded
                         text-zinc-100 transition ring-1 ring-zinc-700"
            >
              Verify
            </button>
          </div>
        )}

        {verified && verify.isLoading && (
          <div className="text-xs text-zinc-400 py-3">Checking sample files…</div>
        )}
        {verified && verify.error && (
          <div className="text-[11px] text-amber-300 bg-amber-950/30 ring-1 ring-amber-900/40
                          rounded px-3 py-2 mb-4">
            {verify.error.message}
          </div>
        )}
        {verified && result && (
          <div className="space-y-3 mb-1">
            <div className="ring-1 ring-zinc-800 rounded bg-zinc-950/50 p-3">
              <div className="text-[11px] text-zinc-500 mb-2">
                Sample of {result.sample_size} of {result.total_files.toLocaleString()} file(s) under{' '}
                <span className="font-mono">{result.new_root}</span>
                {!result.new_root_exists && (
                  <span className="text-red-400 ml-1">— path does not exist</span>
                )}
              </div>
              <ul className="space-y-1.5 max-h-44 overflow-y-auto">
                {result.samples.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] font-mono">
                    <span className={s.exists_at_new ? 'text-emerald-400' : 'text-red-400'}>
                      {s.exists_at_new ? '✓' : '✗'}
                    </span>
                    <span className="text-zinc-300 break-all">{s.rel_path}</span>
                  </li>
                ))}
                {result.samples.length === 0 && (
                  <li className="text-[11px] text-zinc-500">
                    (no files in this storage yet — nothing to verify)
                  </li>
                )}
              </ul>
            </div>
            {someSamplesMissing && (
              <div className="text-[11px] text-amber-300 bg-amber-950/30 ring-1 ring-amber-900/40
                              rounded px-3 py-2">
                Some sampled files weren&apos;t found at the new root. This may be a partial copy,
                a renamed sub-folder, or a wrong root. You can still commit, but missing files
                will show as broken until the copy finishes.
              </div>
            )}
            {error && (
              <div className="text-[11px] text-amber-300 bg-amber-950/30 ring-1 ring-amber-900/40
                              rounded px-3 py-2">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={apply.isPending || !result.new_root_exists}
                className="px-4 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 rounded
                           text-emerald-50 transition disabled:opacity-50
                           disabled:cursor-not-allowed"
              >
                {apply.isPending ? 'Applying…' : someSamplesMissing ? 'Commit anyway' : 'Commit'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
