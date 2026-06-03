'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';

/**
 * Admin banner shown above every /admin page. Three states, in priority order:
 *   1. A build is ready and awaiting a (manual) restart.
 *   2. An upgrade was just kicked off — point the admin at the Jobs progress.
 *   3. A newer version is published — offer the one-click Upgrade.
 *
 * The Upgrade button enqueues the `upgrade` job through the existing
 * requireAdmin-gated POST /api/admin/jobs route; live progress streams in the
 * Jobs panel on /admin/storage. Detection + the pending-restart flag come from
 * the `system` tRPC router.
 */
export function AdminUpdateBanner() {
  const update = trpc.system.checkForUpdate.useQuery(undefined, {
    refetchInterval: 30 * 60 * 1000, // releases are infrequent; manifest is cached server-side too
    refetchOnWindowFocus: true,
    staleTime: 5 * 60 * 1000,
  });
  const pending = trpc.system.pendingRestart.useQuery(undefined, {
    refetchInterval: 15 * 1000,
  });

  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startUpgrade = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'upgrade' }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start upgrade');
    } finally {
      setStarting(false);
    }
  };

  // 1) Built, awaiting restart — highest priority.
  const pendingVersion = pending.data?.version ?? null;
  if (pendingVersion) {
    return (
      <Banner tone="amber">
        <span className="flex-1">
          <strong className="font-semibold">Update built.</strong>{' '}
          Restart the server to run v{pendingVersion}.
        </span>
      </Banner>
    );
  }

  // 2) Upgrade just kicked off.
  if (started) {
    return (
      <Banner tone="emerald">
        <span className="flex-1">
          <strong className="font-semibold">Upgrade started.</strong>{' '}
          Watch progress under{' '}
          <a className="underline hover:text-emerald-100" href="/admin/storage">Jobs</a>
          {' '}— you&apos;ll be prompted to restart once the build finishes. Avoid using the app while it builds.
        </span>
      </Banner>
    );
  }

  // 3) Update available.
  if (update.data?.available && update.data.latest) {
    const { latest, bump, notes, url } = update.data;
    return (
      <Banner tone="emerald">
        <span className="flex-1">
          <strong className="font-semibold">Version {latest} available</strong>
          {bump ? <span className="text-emerald-300/70"> ({bump})</span> : null}
          {notes ? <span className="text-emerald-200/80"> — {notes}</span> : null}
          {url ? (
            <a className="underline ml-1 hover:text-emerald-100" href={url} target="_blank" rel="noreferrer">
              release notes
            </a>
          ) : null}
          {error ? <span className="text-red-300 ml-2">· {error}</span> : null}
        </span>
        <button
          onClick={startUpgrade}
          disabled={starting}
          className="shrink-0 rounded-md bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50
                     disabled:cursor-wait px-3 py-1 text-white font-medium transition"
        >
          {starting ? 'Starting…' : 'Upgrade'}
        </button>
      </Banner>
    );
  }

  return null;
}

function Banner({ tone, children }: { tone: 'amber' | 'emerald'; children: React.ReactNode }) {
  const cls =
    tone === 'amber'
      ? 'bg-amber-950/60 ring-amber-900/60 text-amber-100'
      : 'bg-emerald-950/50 ring-emerald-900/60 text-emerald-100';
  return (
    <div className={`mb-6 flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm ring-1 ${cls}`}>
      {children}
    </div>
  );
}
