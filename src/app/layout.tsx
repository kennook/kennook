import type { Metadata, Viewport } from 'next';
import { TRPCProvider } from '@/lib/trpc-client';
import './globals.css';

export const metadata: Metadata = {
  title: 'KenNook',
  description: 'Your personal media library, smarter.',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
  },
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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
