/**
 * KenNook wordmark logo with an optional environment badge.
 *
 * Sourced from /public/kennook.svg. Pass `height` in px; width scales.
 * In non-prod environments a small badge is rendered next to the wordmark
 * so it's obvious which instance you're looking at across tabs.
 */

import { getEnvLabel } from '@/lib/env';

interface Props {
  /** Height in px. Width scales by the SVG's intrinsic aspect ratio (~4.4:1). */
  height?: number;
  /** Show an environment badge in non-prod. Default true. */
  withBadge?: boolean;
  className?: string;
}

export function KenNookLogo({ height = 24, withBadge = true, className }: Props) {
  const envLabel = withBadge ? getEnvLabel() : null;

  return (
    <span className={`relative inline-block ${className ?? ''}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/kennook.svg"
        alt="KenNook"
        style={{ height }}
        className="block select-none"
      />
      {envLabel && (
        <span
          className="absolute -top-1 -right-2 px-1.5 py-0.5 rounded
                     text-[10px] font-mono uppercase tracking-wider leading-none
                     bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40"
          title={`Running in ${envLabel}`}
        >
          {envLabel}
        </span>
      )}
    </span>
  );
}
