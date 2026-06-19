'use client';

/**
 * "Connect a device" — a header button that opens a panel with a scannable QR
 * code and the URLs other devices on the same Wi-Fi can use to reach this
 * KenNook. Zero user setup: the server discovers its own LAN addresses (and
 * advertises `kennook.local` over mDNS); this just surfaces them.
 */

import { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';

interface ConnectInfo {
  mdnsUrl: string;
  networkUrls: string[];
  port: number;
}

export function ConnectDeviceButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Connect another device"
        aria-label="Connect another device"
        className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800
                   rounded px-2 py-1 text-sm transition shrink-0 flex items-center gap-1.5"
      >
        <DeviceIcon />
        <span className="hidden sm:inline">Connect</span>
      </button>
      {open && <ConnectModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/connect-info')
      .then((r) => r.json() as Promise<ConnectInfo>)
      .then(setInfo)
      .catch(() => setError(true));
  }, []);

  // The QR encodes the primary LAN IP URL — the most universally reachable
  // option (mDNS isn't resolvable on every device, e.g. some Androids).
  const primary = info?.networkUrls[0] ?? info?.mdnsUrl ?? null;

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm bg-zinc-900 ring-1 ring-zinc-800 rounded-xl p-6
                      shadow-2xl flex flex-col items-center gap-4">
        <div className="w-full flex items-center justify-between">
          <h2 className="text-base font-medium text-zinc-100">Connect a device</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-200 w-7 h-7 rounded-md
                       hover:bg-white/10 flex items-center justify-center transition"
          >
            ✕
          </button>
        </div>

        <p className="text-xs text-zinc-400 text-center -mt-1">
          On a phone or tablet on the same Wi-Fi, scan this or open a URL below.
        </p>

        {error && (
          <div className="text-sm text-red-400 py-6">Couldn’t load connection info.</div>
        )}

        {!error && !info && (
          <div className="text-sm text-zinc-500 py-6">Loading…</div>
        )}

        {primary && (
          <div className="bg-white p-3 rounded-lg">
            {/* react-qr-code renders crisp SVG at any size. */}
            <QRCode value={primary} size={180} />
          </div>
        )}

        {info && (
          <div className="w-full flex flex-col gap-1.5">
            {info.networkUrls.map((url) => (
              <UrlRow key={url} url={url} label="Network" />
            ))}
            <UrlRow url={info.mdnsUrl} label="Name" hint="(needs mDNS)" />
            {info.networkUrls.length === 0 && (
              <p className="text-xs text-amber-400/90 px-1">
                No LAN address detected — make sure this machine is on Wi-Fi/Ethernet.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function UrlRow({ url, label, hint }: { url: string; label: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); },
      () => {},
    );
  };
  return (
    <button
      onClick={copy}
      title="Copy"
      className="group w-full flex items-center gap-2 text-left bg-zinc-950/60
                 hover:bg-zinc-800 ring-1 ring-zinc-800 rounded-md px-3 py-2 transition"
    >
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 w-14 shrink-0">
        {label}
      </span>
      <span className="text-sm text-zinc-200 truncate flex-1 font-mono">{url}</span>
      {hint && <span className="text-[10px] text-zinc-600 shrink-0">{hint}</span>}
      <span className="text-[11px] text-zinc-500 group-hover:text-zinc-300 shrink-0">
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}

function DeviceIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <line x1="11" y1="18" x2="13" y2="18" />
    </svg>
  );
}
