import { ShortcutEditor } from '@/components/ShortcutEditor';

export default function AdminShortcutsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Keyboard shortcuts</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Instance-wide shortcut defaults. Rebind or disable a shortcut for everyone,
        and <strong>lock</strong> it to stop individual users or their devices from
        changing it. Users can still personalize anything you leave unlocked.
      </p>
      <ShortcutEditor scope="tenant" />
    </div>
  );
}
