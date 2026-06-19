/**
 * Next.js startup hook (runs once when the server boots, in BOTH dev and
 * prod). We use it to kick off zero-config LAN discovery — advertise
 * `kennook.local` over mDNS and print the "connect a device" banner + QR.
 *
 * Guarded to the Node runtime (instrumentation can also run on edge, where
 * mDNS / os APIs don't exist).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startDiscovery } = await import('@/server/discovery');
  await startDiscovery();
}
