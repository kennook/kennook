/**
 * Empty-state placeholder for /admin subsections we've scaffolded but
 * haven't built yet. Renders the title + a one-liner so the sidebar
 * link goes somewhere coherent rather than 404ing.
 */

export function PlaceholderSection({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">{title}</h1>
      <p className="text-sm text-zinc-400 mb-6">{description}</p>
      <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40
                      p-8 text-center text-sm text-zinc-500">
        Coming soon.
      </div>
    </div>
  );
}
