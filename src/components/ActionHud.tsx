'use client';

import { useEffect, useState } from 'react';
import { subscribeHud, type HudFlash, type HudIcon } from '@/lib/action-hud';

/**
 * Renders the transient action glyph centered over the media. Mount once inside
 * the viewer; it listens to the global HUD emitter. Pointer-events-none so it
 * never intercepts clicks. The `key={flash.id}` restarts the CSS pop animation
 * on every flash, and it clears itself when the animation ends.
 */
export function ActionHud() {
  const [flash, setFlash] = useState<HudFlash | null>(null);
  useEffect(() => subscribeHud(setFlash), []);

  if (!flash) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
      <div
        key={flash.id}
        className="kn-hud flex flex-col items-center gap-3"
        onAnimationEnd={() => setFlash((f) => (f?.id === flash.id ? null : f))}
      >
        <div className="rounded-full bg-black/45 backdrop-blur-sm p-7 text-white/85">
          <HudGlyph icon={flash.icon} />
        </div>
        {flash.label && (
          <div className="text-white/90 text-2xl font-semibold tabular-nums drop-shadow">
            {flash.label}
          </div>
        )}
      </div>
    </div>
  );
}

function HudGlyph({ icon }: { icon: HudIcon }) {
  const common = {
    width: 72,
    height: 72,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (icon) {
    case 'play':
      return <svg {...common} fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>;
    case 'pause':
      return <svg {...common} fill="currentColor" stroke="none"><path d="M7 5h3v14H7zM14 5h3v14h-3z" /></svg>;
    case 'mute':
      return (
        <svg {...common}>
          <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
          <path d="M17 9l5 6M22 9l-5 6" />
        </svg>
      );
    case 'unmute':
      return (
        <svg {...common}>
          <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
          <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
        </svg>
      );
    case 'like':
      return <svg {...common} fill="currentColor" stroke="none"><path d="M12 21s-7-4.6-9.3-9C1.2 9 2.6 5.5 6 5.5c2 0 3.2 1.2 4 2.3.8-1.1 2-2.3 4-2.3 3.4 0 4.8 3.5 3.3 6.5C19 16.4 12 21 12 21z" /></svg>;
    case 'next':
      return <svg {...common} fill="currentColor" stroke="none"><path d="M5 5l9 7-9 7zM16 5h3v14h-3z" /></svg>;
    case 'prev':
      return <svg {...common} fill="currentColor" stroke="none"><path d="M19 5l-9 7 9 7zM5 5h3v14H5z" /></svg>;
  }
}
