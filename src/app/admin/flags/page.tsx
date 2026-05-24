import { PlaceholderSection } from '@/components/admin/PlaceholderSection';

export default function AdminFlagsPage() {
  return (
    <PlaceholderSection
      title="Feature flags"
      description="Toggle in-development features for this instance. Currently lives as a typed object in `src/lib/feature-flags.ts`; this section will surface the same flags with a UI plus admin-only override."
    />
  );
}
