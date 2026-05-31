/**
 * Returns a short label for the current environment, or `null` in production.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_KENNOOK_ENV` — explicit override (set in .env.local for
 *      "staging", "qa", whatever). Any value other than "production"/"prod"
 *      surfaces as a badge.
 *   2. `NODE_ENV === 'development'` → "dev". This covers `next dev`.
 *   3. otherwise → null (production build, no badge).
 *
 * Safe to call from both server and client code — Next.js inlines these env
 * vars at build time.
 */
export function getEnvLabel(): string | null {
  const explicit = process.env.NEXT_PUBLIC_KENNOOK_ENV;
  if (explicit && explicit !== 'production' && explicit !== 'prod') {
    return explicit;
  }
  if (process.env.NODE_ENV === 'development') return 'dev';
  return null;
}
