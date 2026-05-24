/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 15: 'serverExternalPackages' (stable) replaces the old
  // 'experimental.serverComponentsExternalPackages'.
  serverExternalPackages: [
    'sqlite-vec',
    '@huggingface/transformers',
    'sharp',
  ],
  // Hide the dev-mode indicator in the corner. It's useful when actively
  // debugging route compilation, but mostly just gets in the way of UI.
  devIndicators: false,
  // Toggle distDir via env so `pnpm build:prod` / `pnpm start:prod` can
  // run side-by-side with `pnpm dev` without trashing each other's
  // build cache. Both prod scripts set KENNOOK_PROD=1 → `.next-prod`;
  // dev leaves it unset → default `.next`.
  distDir: process.env.KENNOOK_PROD === '1' ? '.next-prod' : '.next',
};

export default nextConfig;
