/**
 * The local cloud agent — the app-side half of the KenNook cloud spine ("M5").
 *
 * Responsibilities (Slice 1): device-code enrollment, then a steady heartbeat
 * that refreshes entitlements. Cert issuance (CSR + install) is Slice 2.
 *
 * NON-BREAKING: every entry point no-ops unless `cloudConfigured()`. All network
 * work is best-effort with swallowed errors — a cloud outage must never surface
 * to, or block, the local app. Loops are in-process timers (this runs in the
 * long-lived `next start` node process, like the sync broker / job runner).
 */

import os from 'node:os';
import { KENNOOK_VERSION, KENNOOK_BUILD_ID } from '@/lib/version';
import { cloudConfigured, CLOUD_CERT_ZONE, HEARTBEAT_INTERVAL_MS } from './config';
import { enrollStart, enrollPoll, heartbeat } from './client';
import { obtainCertificate, getCertState } from './certs';
import {
  readAgentCreds, writeAgentCreds, clearAgentCreds,
  readEntitlements, writeEntitlements, type Entitlements,
} from './store';

/** Kick a best-effort cert acquisition/renewal, but only when a cert zone is
 *  configured — otherwise certs aren't part of this instance's opt-in and we
 *  stay silent. obtainCertificate() self-skips when a fresh cert already exists. */
function maybeObtainCert(): void {
  if (CLOUD_CERT_ZONE) void obtainCertificate();
}

interface PendingEnrollment {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

let pending: PendingEnrollment | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;

// ── Status (for the admin UI) ────────────────────────────────────────────────

export interface CertStatus {
  domain: string;
  notAfter: number | null;
  issuedAt: number;
}

export interface CloudStatus {
  enabled: boolean;        // configured on this instance at all
  enrolled: boolean;
  connecting: boolean;     // enrollment in progress, awaiting approval
  agentId: string | null;
  pending: { userCode: string; verificationUri: string } | null;
  entitlements: Entitlements | null;
  certZone: string | null; // cert-plane zone if issuance is configured
  cert: CertStatus | null; // the installed wildcard cert, if any
  certPending: boolean;    // an issuance/renewal is in flight
  certError: string | null;
  lastError: string | null;
}

export function getCloudStatus(): CloudStatus {
  const creds = cloudConfigured() ? readAgentCreds() : null;
  const cs = creds ? getCertState() : { pending: false, lastError: null, meta: null };
  return {
    enabled: cloudConfigured(),
    enrolled: !!creds,
    connecting: !!pending,
    agentId: creds?.agentId ?? null,
    pending: pending ? { userCode: pending.userCode, verificationUri: pending.verificationUri } : null,
    entitlements: creds ? readEntitlements() : null,
    certZone: CLOUD_CERT_ZONE || null,
    cert: cs.meta ? { domain: cs.meta.domain, notAfter: cs.meta.notAfter, issuedAt: cs.meta.issuedAt } : null,
    certPending: cs.pending,
    certError: cs.lastError,
    lastError,
  };
}

// ── Enrollment ───────────────────────────────────────────────────────────────

/** Begin device-code enrollment; returns the code/URL to show the operator. */
export async function startEnrollment(): Promise<{ userCode: string; verificationUri: string }> {
  if (!cloudConfigured()) throw new Error('Cloud is not enabled on this instance.');
  if (readAgentCreds()) throw new Error('This instance is already connected. Disconnect first.');
  if (pending) return { userCode: pending.userCode, verificationUri: pending.verificationUri };

  const r = await enrollStart();
  pending = {
    deviceCode: r.device_code,
    userCode: r.user_code,
    verificationUri: r.verification_uri_complete,
    expiresAt: Date.now() + r.expires_in * 1000,
  };
  lastError = null;
  schedulePoll(Math.max(1, r.interval) * 1000);
  return { userCode: pending.userCode, verificationUri: pending.verificationUri };
}

export function cancelEnrollment(): void {
  pending = null;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function schedulePoll(delayMs: number): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { void pollOnce(); }, delayMs);
}

async function pollOnce(): Promise<void> {
  if (!pending) return;
  if (Date.now() > pending.expiresAt) { lastError = 'Enrollment code expired.'; cancelEnrollment(); return; }
  const interval = 5000;
  try {
    const r = await enrollPoll(pending.deviceCode);
    if (r.status === 'approved') {
      writeAgentCreds({ agentId: r.agent_id, hash: r.hash, token: r.token, enrolledAt: Date.now() });
      cancelEnrollment();
      lastError = null;
      startHeartbeat();  // begin the steady loop immediately
      maybeObtainCert(); // fetch the wildcard cert now that we're enrolled
      return;
    }
    schedulePoll(interval); // pending — keep waiting
  } catch (e) {
    // expired_token / transient — surface briefly, keep polling until it expires.
    lastError = e instanceof Error ? e.message : String(e);
    if (/expired_token/.test(lastError)) { cancelEnrollment(); return; }
    schedulePoll(interval);
  }
}

/** Forget this instance's cloud identity + stop all cloud activity. */
export function disconnect(): void {
  cancelEnrollment();
  stopHeartbeat();
  clearAgentCreds();
  lastError = null;
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

function localIps(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out.slice(0, 16);
}

async function beat(): Promise<void> {
  const creds = readAgentCreds();
  if (!creds) { stopHeartbeat(); return; }
  try {
    const r = await heartbeat(creds.token, {
      version: KENNOOK_VERSION,
      buildId: KENNOOK_BUILD_ID,
      health: 'ok',
      ipv4: localIps(),
    });
    const ent: Entitlements = {
      tier: r.entitlements.tier,
      membershipActive: r.entitlements.membershipActive,
      features: r.entitlements.features,
      fetchedAt: Date.now(),
      ttl: r.entitlements_ttl,
    };
    writeEntitlements(ent);
    lastError = null;
    // Renewal seam: a cheap freshness check that self-skips unless the cert is
    // missing or within its renew window. (commands[] is still an empty stub —
    // drained here when the spine starts issuing renew-cert / deprovision.)
    maybeObtainCert();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastError = msg;
    // The spine forgot this agent (revoked/deleted) → stop pretending we're
    // enrolled so the operator can reconnect.
    if (/unknown_agent|→ 401|→ 403/.test(msg)) { clearAgentCreds(); stopHeartbeat(); }
  }
}

export function startHeartbeat(): void {
  if (!cloudConfigured() || !readAgentCreds()) return;
  if (heartbeatTimer) return;
  void beat(); // fire one now
  heartbeatTimer = setInterval(() => { void beat(); }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/** Called once on server boot. Resumes the heartbeat if already enrolled; a
 *  no-op when cloud is off or not yet connected. */
export function startCloudAgent(): void {
  if (!cloudConfigured()) return;
  if (readAgentCreds()) { startHeartbeat(); maybeObtainCert(); }
}
