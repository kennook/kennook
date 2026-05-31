import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'KenNook — AI-native personal media library',
  description:
    'Self-hosted, AI-native media library. Search by what your photos and videos actually contain — not just filenames.',
};

// React 19's ReactNode union includes a stricter ReactPortal variant — using
// the imported `ReactNode` type as a children type clashes with the JSX
// namespace's expectation. Wrapping in `Readonly` + accessing via `React.`
// namespace matches Next 15's official template and avoids the mismatch.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
