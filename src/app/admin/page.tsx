import { redirect } from 'next/navigation';

// /admin lands on /admin/storage — the consolidated "where are my files
// and what's happening with them" view. Indexing/backfill/enrich actions
// live on each storage row; the job queue is rendered below the table.
export default function AdminIndexPage() {
  redirect('/admin/storage');
}
