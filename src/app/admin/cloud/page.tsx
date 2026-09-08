import { CloudConnection } from '@/components/admin/CloudConnection';

export default function AdminCloudPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Cloud</h1>
      <p className="text-sm text-zinc-400 mb-6">
        Connect this instance to the KenNook cloud — a real hostname over HTTPS,
        remote access, and membership. Off by default; your media stays local.
      </p>
      <CloudConnection />
    </div>
  );
}
