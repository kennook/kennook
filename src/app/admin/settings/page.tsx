import { ScreensaverAdmin } from '@/components/admin/ScreensaverAdmin';

export default function AdminScreensaverPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Screensaver</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Everything about the walk-away screensaver — turn it on or off, set an
        unlock passcode, and upload your own footage.
      </p>
      <ScreensaverAdmin />
    </div>
  );
}
