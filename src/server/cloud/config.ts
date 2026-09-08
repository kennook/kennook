/**
 * Cloud control-plane (KenNook cloud spine) configuration.
 *
 * HARD INVARIANT: the entire cloud agent is OFF unless the operator opts in via
 * env. With it off — the default, and the shippable binary's default — KenNook
 * makes zero cloud contact and behaves exactly as a LAN-only install. Nothing in
 * this subtree may ever be reached, imported for effect, or block a request when
 * `cloudConfigured()` is false.
 *
 *   KENNOOK_CLOUD_ENABLED=1                              — master opt-in
 *   KENNOOK_CLOUD_API_URL=https://<id>.execute-api.us-west-2.amazonaws.com
 *                                                        — the spine HTTP API base
 *
 * The API base is the auto-generated API Gateway endpoint (per env / account);
 * there's no stable alias yet, so it's supplied out-of-band rather than baked in.
 */

const RAW_ENABLED = process.env.KENNOOK_CLOUD_ENABLED === '1';
/** Spine HTTP API base URL, trailing slash stripped. */
export const CLOUD_API_URL = (process.env.KENNOOK_CLOUD_API_URL ?? '').replace(/\/+$/, '');

/** True only when cloud is opted-in AND an API base is set. Every cloud code
 *  path must guard on this and no-op when false. */
export function cloudConfigured(): boolean {
  return RAW_ENABLED && CLOUD_API_URL.length > 0;
}

/** How often the agent heartbeats once enrolled (ms). More frequent than the
 *  3600s entitlement TTL so paid-state changes and lastSeen stay fresh, but not
 *  chatty. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
