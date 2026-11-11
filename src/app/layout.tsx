import type { Metadata, Viewport } from 'next';
import { TRPCProvider } from '@/lib/trpc-client';
import { TooltipLayer } from '@/components/TooltipLayer';
import './globals.css';

export const metadata: Metadata = {
  title: 'KenNook',
  description: 'Your personal media library, smarter.',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/icon-192.png' }],
  },
  // Installed-PWA hints. The manifest (app/manifest.ts) is what makes it
  // installable — an installed PWA gets Chrome autoplay-with-sound that survives
  // the auto-update reload. These round out the install / standalone experience.
  applicationName: 'KenNook',
  appleWebApp: { capable: true, title: 'KenNook', statusBarStyle: 'black-translucent' },
};

// Disable pinch + double-tap zoom on mobile. The viewer's video element
// triggers iOS Safari's tap-to-zoom heuristic when the user taps near
// the native controls, which throws the layout off and competes with
// our chrome. Trading away page zoom is acceptable here because the
// content (photos / videos) is already presented at the right scale.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#1A1815',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TRPCProvider>{children}</TRPCProvider>
        <TooltipLayer />
      </body>
    </html>
  );
}
