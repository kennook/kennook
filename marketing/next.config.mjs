/** @type {import('next').NextConfig} */
const nextConfig = {
  // OpenNext consumes the default Next build output; no `output: 'export'`
  // since we need SSR + API routes server-side on Lambda.
  reactStrictMode: true,
};

export default nextConfig;
