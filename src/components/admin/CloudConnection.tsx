'use client';

/**
 * Admin control for connecting this instance to the KenNook cloud (the spine).
 * Device-code flow: click Connect → a short code + link appear → approve it in
 * the cloud in your browser → this card flips to "Connected" once the agent's
 * background poll sees the approval. All cloud work is off unless the operator
 * opted in via env, so this card is honest about that state too.
 */

import { trpc } from '@/lib/trpc-client';
import type { CloudStatus } from '@/server/cloud/agent';

export function CloudConnection() {
  const utils = trpc.useUtils();
  const status = trpc.cloud.status.useQuery(undefined, {
    // While an enrollment is pending, poll so the card flips to Connected on its
    // own the moment the background agent sees the approval.
    refetchInterval: (q) => (q.state.data?.connecting ? 3000 : false),
  });
  const s = status.data;

  const connect = trpc.cloud.connect.useMutation({ onSettled: () => utils.cloud.status.invalidate() });
  const cancel = trpc.cloud.cancel.useMutation({ onSettled: () => utils.cloud.status.invalidate() });
  const disconnect = trpc.cloud.disconnect.useMutation({ onSettled: () => utils.cloud.status.invalidate() });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-medium text-zinc-200">Cloud connection</h2>
        <StatusChip s={s} />
      </div>
      <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
        Connect this instance to the KenNook cloud for a real hostname + HTTPS
        (which also gives every browser HTTP/2, ending the multi-window connection
        crunch), remote access, and membership features. Your media never leaves
        this machine — only a secure identity + heartbeat.
      </p>

      {!s ? (
        <div className="text-xs text-zinc-500">Loading…</div>
      ) : !s.enabled ? (
        <div className="text-xs text-zinc-400 bg-zinc-950/40 ring-1 ring-zinc-800 rounded-md p-3 leading-relaxed">
          Cloud is not enabled on this instance. Set{' '}
          <code className="text-zinc-300">KENNOOK_CLOUD_ENABLED=1</code> and{' '}
          <code className="text-zinc-300">KENNOOK_CLOUD_API_URL</code> (the spine API
          base) in the server environment, then restart.
        </div>
      ) : s.connecting && s.pending ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-zinc-300">
            Approve this instance in the cloud to finish connecting:
          </p>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold tracking-[0.2em] tabular-nums text-emerald-300">
              {s.pending.userCode}
            </span>
            <a
              href={s.pending.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
            >
              Open approval page ↗
            </a>
          </div>
          <p className="text-xs text-zinc-500">Waiting for approval…</p>
          <button
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="self-start text-sm text-zinc-400 hover:text-red-300 transition disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      ) : s.enrolled ? (
        <div className="flex flex-col gap-4">
          <Entitlements s={s} />
          <div className="text-[11px] text-zinc-600 font-mono truncate">agent {s.agentId}</div>
          <button
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
            className="self-start text-sm text-zinc-400 hover:text-red-300 transition disabled:opacity-40"
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect this instance'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
          className="bg-zinc-200 text-zinc-900 rounded-md px-3 py-1.5 text-sm font-medium
                     hover:bg-white disabled:opacity-40 transition"
        >
          {connect.isPending ? 'Starting…' : 'Connect this instance'}
        </button>
      )}

      {(connect.error || s?.lastError) && (
        <div className="text-xs text-red-400 mt-3">{connect.error?.message ?? s?.lastError}</div>
      )}
    </div>
  );
}

function StatusChip({ s }: { s: CloudStatus | undefined }) {
  const [label, cls] = !s || !s.enabled
    ? ['Off', 'bg-zinc-800 text-zinc-400']
    : s.enrolled
      ? ['Connected', 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30']
      : s.connecting
        ? ['Connecting…', 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30']
        : ['Not connected', 'bg-zinc-800 text-zinc-400'];
  return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{label}</span>;
}

function Entitlements({ s }: { s: CloudStatus }) {
  const e = s.entitlements;
  if (!e) return <div className="text-xs text-zinc-500">Fetching membership…</div>;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm text-zinc-200">
        Plan: <span className="font-medium">{e.tier}</span>
        {e.membershipActive
          ? <span className="ml-2 text-emerald-300">· membership active</span>
          : <span className="ml-2 text-zinc-500">· free</span>}
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]">
        <Feature on={e.features.remoteAccess} label="Remote access" />
        <Feature on={e.features.cloudAI} label="Cloud AI" />
        <Feature on={e.features.metadataSync} label="Metadata sync" />
      </div>
    </div>
  );
}

function Feature({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full ring-1 ${on
      ? 'text-emerald-300 ring-emerald-700/60'
      : 'text-zinc-500 ring-zinc-700'}`}>
      {label} {on ? 'on' : 'off'}
    </span>
  );
}
