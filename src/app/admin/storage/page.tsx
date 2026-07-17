/**
 * /admin/storage — manage storage_locations for the current library.
 *
 * Each row shows the storage's root path, online/offline status, and file
 * count. Add a new storage (validates dir + rejects overlap), Relocate an
 * existing one (dry-run verifies a sample of files at the new path, then
 * commits), or Remove (refused while it still has media_items).
 */

import { StorageClient } from '@/components/admin/StorageClient';
import { UploadAssetsCard } from '@/components/admin/UploadAssetsCard';

export default function AdminStoragePage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Storage</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Where KenNook reads your media from. Add a folder to start indexing it,
        or relocate a storage when you move files to a new drive — your library
        survives the move because everything is keyed by content hash.
      </p>
      <StorageClient />
      {/* Upload is a convenience, not the main event — keep it out of the way
          at the bottom of the page. */}
      <div className="mt-10 pt-6 border-t border-zinc-900">
        <div className="ring-1 ring-zinc-800 rounded-lg p-4 bg-zinc-950/40">
          <UploadAssetsCard />
        </div>
      </div>
    </div>
  );
}
