import { ConfigurationSettings } from '@/components/admin/ConfigurationSettings';

export default function AdminConfigurationPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Configuration</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Instance-wide on/off switches. Changes apply to every device on this
        KenNook.
      </p>
      <ConfigurationSettings />
    </div>
  );
}
