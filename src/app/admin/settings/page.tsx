import { ScreensaverLockSettings } from '@/components/admin/ScreensaverLockSettings';

export default function AdminSettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Settings</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Instance-wide configuration. More knobs (index roots, sensitive
        thresholds, default fit/zoom, slideshow defaults) will land here; today
        it hosts the screensaver lock.
      </p>
      <ScreensaverLockSettings />
    </div>
  );
}
