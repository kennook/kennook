import type { MetadataRoute } from 'next';

/**
 * Web-app manifest — makes KenNook installable as a desktop/mobile PWA.
 *
 * Why it exists: Chrome grants an INSTALLED PWA autoplay-with-sound, and that
 * permission survives a page reload — including the silent auto-update reload a
 * new release triggers. Running a wall screen as the installed app (standalone
 * window) means videos resume with sound after a deploy without anyone touching
 * the device. `display: 'standalone'` is the part that matters for that.
 *
 * Next serves this at /manifest.webmanifest and injects <link rel="manifest">
 * automatically. Icons are generated from public/favicon.svg by
 * scripts/gen-pwa-icons.mjs.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'KenNook',
    short_name: 'KenNook',
    description: 'Your personal media library, smarter.',
    start_url: '/',
    display: 'standalone',
    background_color: '#1A1815',
    theme_color: '#1A1815',
    orientation: 'any',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
