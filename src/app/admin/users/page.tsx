import { UserPasswordsSettings } from '@/components/admin/UserPasswordsSettings';
import { InvalidateSessionsCard } from '@/components/admin/InvalidateSessionsCard';

export default function AdminUsersPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Users</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Create accounts, set login passwords, or remove people. Each named
        account keeps its own private likes, history, and saved searches.
      </p>
      <UserPasswordsSettings />
      <InvalidateSessionsCard />
    </div>
  );
}
