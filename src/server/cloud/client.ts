/**
 * Thin typed client for the KenNook cloud spine HTTP API. Shapes mirror the
 * handlers exactly (snake_case as the API returns). Every call has a short
 * timeout and surfaces errors to the caller, which is responsible for swallowing
 * them — the agent must never let a cloud hiccup affect the local app.
 */

import { CLOUD_API_URL } from './config';

const TIMEOUT_MS = 15_000;

async function call<T>(pathname: string, init: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CLOUD_API_URL}${pathname}`, {
      ...init,
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(`spine ${pathname} → ${res.status} ${(body as { error?: string }).error ?? ''}`.trim());
    }
    return body as T;
  } finally {
    clearTimeout(t);
  }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ── Enrollment (unauthenticated) ─────────────────────────────────────────────

export interface EnrollStartResp {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;    // seconds between polls
  expires_in: number;  // seconds until the code dies
}
export function enrollStart(): Promise<EnrollStartResp> {
  return call<EnrollStartResp>('/enroll/start', { method: 'POST', body: '{}' });
}

export type EnrollPollResp =
  | { status: 'pending' }
  | { status: 'approved'; agent_id: string; hash: string; token: string };
export function enrollPoll(deviceCode: string): Promise<EnrollPollResp> {
  return call<EnrollPollResp>('/enroll/poll', {
    method: 'POST',
    body: JSON.stringify({ device_code: deviceCode }),
  });
}

// ── Agent (bearer-token) ─────────────────────────────────────────────────────

export interface HeartbeatBody {
  version?: string;
  buildId?: string;
  health?: string;
  ipv4?: string[];
}
export interface HeartbeatResp {
  entitlements: {
    tier: string;
    membershipActive: boolean;
    features: { remoteAccess: boolean; cloudAI: boolean; metadataSync: boolean };
  };
  entitlements_ttl: number;
  commands: unknown[];
  server_time: string;
}
export function heartbeat(token: string, body: HeartbeatBody): Promise<HeartbeatResp> {
  return call<HeartbeatResp>('/agent/heartbeat', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

export interface AgentMeResp { agent_id: string; account_id: string; hash: string }
export function getMe(token: string): Promise<AgentMeResp> {
  return call<AgentMeResp>('/agent/me', { method: 'GET', headers: authHeaders(token) });
}
