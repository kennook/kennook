/**
 * Persisted cloud-agent state, under DATA_ROOT/cloud/ with tight file modes
 * (the bearer token is a secret). Separate from user.db so it's trivially
 * deletable ("forget this instance") and never entangled with app data.
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_ROOT = process.env.KENNOOK_DATA_ROOT ?? './data';
const CLOUD_DIR = path.join(DATA_ROOT, 'cloud');
const CREDS_PATH = path.join(CLOUD_DIR, 'agent.json');
const ENTITLEMENTS_PATH = path.join(CLOUD_DIR, 'entitlements.json');

/** What the spine hands back on approved enrollment — the agent's identity. */
export interface AgentCreds {
  agentId: string;
  hash: string;   // per-agent cert-plane label → its *.<hash>.<zone> cert domain
  token: string;  // kna_<agentId>.<hex> bearer secret — treat as sensitive
  enrolledAt: number;
}

export interface CloudFeatures {
  remoteAccess: boolean;
  cloudAI: boolean;
  metadataSync: boolean;
}
export interface Entitlements {
  tier: string;
  membershipActive: boolean;
  features: CloudFeatures;
  /** When we last fetched these + the server-given TTL (seconds), so callers can
   *  tell whether the cache is still warm. */
  fetchedAt: number;
  ttl: number;
}

function ensureDir(): void {
  if (!fs.existsSync(CLOUD_DIR)) fs.mkdirSync(CLOUD_DIR, { recursive: true, mode: 0o700 });
}

function readJson<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch { return null; }
}

export function readAgentCreds(): AgentCreds | null {
  const c = readJson<AgentCreds>(CREDS_PATH);
  return c && c.agentId && c.token && c.hash ? c : null;
}

export function writeAgentCreds(creds: AgentCreds): void {
  ensureDir();
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export function clearAgentCreds(): void {
  for (const p of [CREDS_PATH, ENTITLEMENTS_PATH]) fs.rmSync(p, { force: true });
}

export function readEntitlements(): Entitlements | null {
  return readJson<Entitlements>(ENTITLEMENTS_PATH);
}

export function writeEntitlements(e: Entitlements): void {
  ensureDir();
  fs.writeFileSync(ENTITLEMENTS_PATH, JSON.stringify(e, null, 2) + '\n', { mode: 0o600 });
}
