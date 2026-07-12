/**
 * /admin/storage/[id] — full-page file browser for one storage location.
 * Browse the real filesystem tree, see what's indexed, and prune junk
 * (ignore / remove from library / delete from disk).
 */

import { StorageBrowser } from '@/components/admin/StorageBrowser';

export default async function StorageBrowsePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StorageBrowser storageId={Number(id)} />;
}
