/**
 * Server-side update detection + the "built, awaiting restart" flag.
 *
 * Detection polls a version manifest we publish on our own infra (configurable
 * via KENNOOK_UPDATE_MANIFEST_URL). Fetching server-side avoids CORS and keeps
 * the URL/any token off the client. Results are cached process-wide with a TTL
 * so the admin UI can poll cheaply.
 *
 * The pending-restart flag is written by scripts/upgrade.ts on a successful
 * build and read by the admin banner; it self-clears once the running build
 * (KENNOOK_VERSION, baked at build time) has caught up to the staged version.
 */

import { getUserSqlite } from '@/db/user-client';
import { KENNOOK_VERSION } from '@/lib/version';
import { isNewer, classifyBump, type Bump } from '@/lib/semver';

const MANIFEST_URL =
  process.env.KENNOOK_UPDATE_MANIFEST_URL ?? 'https://kennook.com/version.json';
const PENDING_RESTART_KEY = 'update.pendingRestartVersion';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — releases are infrequent

interface Manifest {
  version: string;
  notes?: string;
  url?: string;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  bump: Bump | null;
  notes: string | null;
  url: string | null;
  checkedAt: number;
}

let cache: { at: number; manifest: Manifest | null } | null = null;

async function fetchManifest(): Promise<Manifest | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.manifest;
  try {
    const res = await fetch(MANIFEST_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const data = (await res.json()) as Partial<Manifest>;
    const manifest = typeof data?.version === 'string' ? (data as Manifest) : null;
    cache = { at: Date.now(), manifest };
    return manifest;
  } catch {
    // Cache the miss for the TTL too so a down endpoint isn't hammered; keep
    // the last good manifest if we had one.
    cache = { at: Date.now(), manifest: cache?.manifest ?? null };
    return cache.manifest;
  }
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = KENNOOK_VERSION;
  const manifest = await fetchManifest();
  const latest = manifest?.version ?? null;
  const available = !!latest && isNewer(latest, current);
  return {
    current,
    latest,
    available,
    bump: latest ? classifyBump(current, latest) : null,
    notes: manifest?.notes ?? null,
    url: manifest?.url ?? null,
    checkedAt: Date.now(),
  };
}

/** Version that has been built and is waiting for a restart, or null. Self-
 *  clears when the running build is already at/ahead of it. */
export function getPendingRestartVersion(): string | null {
  const db = getUserSqlite();
  const row = db
    .prepare('SELECT value FROM user_settings WHERE user_id = 1 AND key = ?')
    .get(PENDING_RESTART_KEY) as { value: string | null } | undefined;
  const v = row?.value ?? null;
  if (v && !isNewer(v, KENNOOK_VERSION)) {
    clearPendingRestart();
    return null;
  }
  return v;
}

export function setPendingRestartVersion(version: string): void {
  const db = getUserSqlite();
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(PENDING_RESTART_KEY, version, Date.now());
}

export function clearPendingRestart(): void {
  const db = getUserSqlite();
  db.prepare('DELETE FROM user_settings WHERE user_id = 1 AND key = ?').run(
    PENDING_RESTART_KEY,
  );
}
