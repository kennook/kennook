import { redirect } from 'next/navigation';

// /admin lands on /admin/indexing (the operational "what does my Kennook
// need next" view). Subsections are reachable from the sidebar.
export default function AdminIndexPage() {
  redirect('/admin/indexing');
}
