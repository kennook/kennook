import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

// Build identity, captured at build time and inlined into both the client and
// server bundles via `env` below. The version comes from package.json; the
// build id is the short git sha.
//
// CRITICAL: this MUST be deterministic for a given commit. next.config.mjs is
// evaluated separately for the client and server compilation passes (and again
// at `next start`), so anything non-deterministic here (e.g. Date.now()) bakes
// DIFFERENT ids into the client vs server bundles — and the reload prompt then
// compares two ids that never match, showing a banner that can't be dismissed.
// The git sha is stable across all of those evaluations. Same-commit rebuilds
// share an id (fine — the code is identical); real releases bump the commit AND
// package.json version, both of which the prompt keys off.
function computeBuildId() {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (sha) return sha;
  } catch { /* not a git checkout / git unavailable */ }
  return 'dev';
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 15: 'serverExternalPackages' (stable) replaces the old
  // 'experimental.serverComponentsExternalPackages'.
  serverExternalPackages: [
    'sqlite-vec',
    '@huggingface/transformers',
    'sharp',
  ],
  // The LAN-discovery deps are Node-only and must NEVER be bundled — webpack
  // can't resolve their Node built-ins (os / dgram / dns). `serverExternalPackages`
  // doesn't reliably cover the `instrumentation.ts` compilation, so force them
  // external for EVERY server webpack pass here. They're `require()`d from
  // node_modules at runtime, where Node resolves the built-ins natively.
  // (`bonjour-service` being external means its transitive `multicast-dns` /
  // `dns-packet` are never followed either.)
  webpack: (config, { isServer }) => {
    if (isServer) {
      const pkgs = ['bonjour-service', 'multicast-dns', 'qrcode-terminal'];
      const prev = Array.isArray(config.externals)
        ? config.externals
        : [config.externals].filter(Boolean);
      config.externals = [
        ...prev,
        ...pkgs,
        // Externalize the `node:` URI scheme. The instrumentation.ts server
        // compilation (in dev) otherwise throws UnhandledSchemeError on
        // `node:os` from discovery.ts; Node resolves `node:*` natively at
        // runtime, so a plain require is correct.
        ({ request }, cb) =>
          request && request.startsWith('node:')
            ? cb(null, 'commonjs ' + request)
            : cb(),
      ];
    }
    return config;
  },
  // Hide the dev-mode indicator in the corner. It's useful when actively
  // debugging route compilation, but mostly just gets in the way of UI.
  devIndicators: false,
  // Inlined into client + server bundles. Read via src/lib/version.ts.
  env: {
    NEXT_PUBLIC_KENNOOK_VERSION: pkg.version,
    NEXT_PUBLIC_KENNOOK_BUILD_ID: computeBuildId(),
  },
  // Toggle distDir via env so `pnpm build:prod` / `pnpm start:prod` can
  // run side-by-side with `pnpm dev` without trashing each other's
  // build cache. Both prod scripts set KENNOOK_PROD=1 → `.next-prod`;
  // dev leaves it unset → default `.next`. The upgrade job sets
  // KENNOOK_BUILD_STAGING=1 to build into `.next-prod-staging` instead, so
  // the rebuild never disturbs the live `.next-prod` the prod server serves
  // from — it's swapped into place only at the very end (see scripts/upgrade.ts).
  distDir: process.env.KENNOOK_BUILD_STAGING === '1'
    ? '.next-prod-staging'
    : process.env.KENNOOK_PROD === '1' ? '.next-prod' : '.next',
};

export default nextConfig;
