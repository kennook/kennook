/**
 * Build identity for the running bundle. Both values are inlined at BUILD
 * time by `next.config.mjs` (via `NEXT_PUBLIC_*` env), so they describe the
 * build that is actually running — NOT the current git checkout. That
 * distinction matters during an upgrade: after `git pull` rewrites
 * package.json the running process keeps reporting its old baked version
 * until it is rebuilt and restarted, which is exactly the signal the reload
 * prompt and the "restart to apply" banner key off.
 *
 * Safe to import from both client and server code — `NEXT_PUBLIC_*` envs are
 * inlined into both bundles.
 */

/** Semver string, e.g. "0.1.0". Falls back to "0.0.0" in unbuilt/dev edge cases. */
export const KENNOOK_VERSION = process.env.NEXT_PUBLIC_KENNOOK_VERSION ?? '0.0.0';

/** Opaque per-build id (short git sha, or a build timestamp fallback). Changes
 *  on every build even when the semver doesn't — used to detect rebuilds. */
export const KENNOOK_BUILD_ID = process.env.NEXT_PUBLIC_KENNOOK_BUILD_ID ?? 'dev';
