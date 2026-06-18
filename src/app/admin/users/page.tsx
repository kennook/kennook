import { UserPasswordsSettings } from '@/components/admin/UserPasswordsSettings';

export default function AdminUsersPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Users</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Two accounts are seeded today (Viewer, Admin). Create / rename / delete
        will land here later; for now you can manage each account&rsquo;s login
        password.
      </p>
      <UserPasswordsSettings />
    </div>
  );
}
