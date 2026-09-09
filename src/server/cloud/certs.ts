/**
 * Slice 2 — TLS certificate acquisition for the cloud agent.
 *
 * Generates the agent's own keypair + CSR LOCALLY (the private key never leaves
 * this machine), submits the CSR to the spine, polls until the ACME issuer
 * returns the signed wildcard cert `*.<hash>.<zone>`, and persists key + chain
 * to the data dir as standard PEMs for a TLS consumer to pick up (a caddy `tls`
 * drop-in today, native in-process TLS later — this module doesn't care how).
 *
 * Entirely gated on `cloudConfigured()` + an enrolled agent + a configured cert
 * zone; a best-effort no-op otherwise. `node-forge` is imported LAZILY so the
 * default LAN-only build never loads it.
 */

import crypto from 'node:crypto';
import { cloudConfigured, CLOUD_CERT_ZONE } from './config';
import { submitCsr, pollCert } from './client';
import { readAgentCreds, readCertMeta, writeCert, type CertMeta } from './store';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 180_000;                  // DNS-01 is ~40-60s; generous ceiling
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000; // renew when <30 days remain

export interface CertResult {
  ok: boolean;
  domain?: string;
  notAfter?: number | null;
  error?: string;
}

/** The wildcard domain this agent's cert covers, or null when no zone is set. */
export function agentCertDomain(hash: string): string | null {
  return CLOUD_CERT_ZONE ? `*.${hash}.${CLOUD_CERT_ZONE}` : null;
}

let inFlight: Promise<CertResult> | null = null;
let lastError: string | null = null;

/** Live cert state for the admin UI. */
export function getCertState(): { pending: boolean; lastError: string | null; meta: CertMeta | null } {
  return { pending: inFlight != null, lastError, meta: readCertMeta() };
}

async function loadForge() {
  const mod = await import('node-forge');
  return mod.default;
}

/**
 * Native (fast, non-blocking) RSA-2048 keygen in PKCS#1; forge only assembles +
 * signs the CSR (its public key derived straight from the private key, so no PEM
 * re-parse). SAN is the single wildcard `*.<hash>.<zone>` — DNS-01 authorizes
 * only within the delegated zone, so the SAN must match what the issuer orders.
 */
async function generateKeyAndCsr(domain: string): Promise<{ keyPem: string; csrPem: string }> {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, // `RSA PRIVATE KEY` — forge-friendly
  });
  const forge = await loadForge();
  const priv = forge.pki.privateKeyFromPem(privateKey);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.setRsaPublicKey(priv.n, priv.e);
  csr.setSubject([{ name: 'commonName', value: domain }]);
  csr.setAttributes([
    {
      name: 'extensionRequest',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: domain }] }],
    },
  ]);
  csr.sign(priv, forge.md.sha256.create());
  return { keyPem: privateKey, csrPem: forge.pki.certificationRequestToPem(csr) };
}

/** Expiry of the leaf cert in a (possibly chained) PEM, epoch ms, or null. */
function certNotAfter(pem: string): number | null {
  try {
    return new Date(new crypto.X509Certificate(pem).validTo).getTime();
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure this agent has a fresh wildcard cert. Skips when a still-valid cert
 * exists (unless `force`). Coalesces concurrent callers. Best-effort — resolves
 * with `{ ok:false, error }` instead of throwing, so callers can safely `void` it.
 */
export function obtainCertificate(opts: { force?: boolean } = {}): Promise<CertResult> {
  if (inFlight) return inFlight;
  inFlight = run(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function run(opts: { force?: boolean }): Promise<CertResult> {
  if (!cloudConfigured()) return fail('cloud_disabled');
  const creds = readAgentCreds();
  if (!creds) return fail('not_enrolled');
  const domain = agentCertDomain(creds.hash);
  if (!domain) return fail('no_cert_zone');

  // Already fresh enough?
  if (!opts.force) {
    const meta = readCertMeta();
    if (meta?.notAfter && meta.notAfter - Date.now() > RENEW_BEFORE_MS) {
      lastError = null;
      return { ok: true, domain: meta.domain, notAfter: meta.notAfter };
    }
  }

  try {
    const { keyPem, csrPem } = await generateKeyAndCsr(domain);
    await submitCsr(creds.token, csrPem);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const r = await pollCert(creds.token);
      if (r.status === 'issued') {
        const notAfter = certNotAfter(r.certificate);
        const meta: CertMeta = { domain: r.domain ?? domain, issuedAt: Date.now(), notAfter };
        writeCert(keyPem, r.certificate, meta);
        lastError = null;
        return { ok: true, domain: meta.domain, notAfter };
      }
      if (Date.now() > deadline) return fail('issuance_timeout');
      // `issuing` / `none` → keep waiting until issued or the deadline.
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function fail(error: string): CertResult {
  lastError = error;
  return { ok: false, error };
}
