'use client';

/**
 * Live progress display for a running job. Replaces the older
 * single-thumbnail ProgressCard with:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ┌────────┐  ENRICH: TEXT · captioning + OCR + tagging       │
 *   │ │ now    │  ━━━━━━━━━━━━━━━━━░░░░░░░░  357 / 7959  (4.5%)   │
 *   │ │ scan   │  7602 to go                                       │
 *   │ │ ╳ ╳ ╳  │                                                   │
 *   │ └────────┘                                                   │
 *   │ recent →  [▣][▣][▣][▣][▣][▣][▣][▣]                            │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * "now scanning" tile has a vertical sweeping bar (keyframes live in
 * app/globals.css as `kn-scan` — styled-jsx breaks if combined with
 * multi-line classNames in this file). The recent strip shows the
 * rolling buffer maintained by the runner (newest first, fading by
 * age).
 *
 * Path items (indexer, pre-DB) don't get thumbnails — file-icon tile
 * + basename label instead.
 */

import { useEffect, useRef, useState } from 'react';
import type { ProgressPayload, RecentItem } from '@/server/admin/progress-protocol';

export function ProgressStrip({
  progress,
  recent,
  isRunning,
}: {
  progress: ProgressPayload;
  recent: RecentItem[];
  /** When false (job finished / not yet started) the animated "now scanning"
   *  tile is hidden — only the bar + recent gallery remain as historical info. */
  isRunning: boolean;
}) {
  const pct =
    typeof progress.current === 'number' &&
    typeof progress.total === 'number' &&
    progress.total > 0
      ? Math.min(100, Math.max(0, (progress.current / progress.total) * 100))
      : null;
  const remaining =
    typeof progress.current === 'number' && typeof progress.total === 'number'
      ? Math.max(0, progress.total - progress.current)
      : null;

  // Rolling log of recognized text (OCR frames / transcript snippets).
  // Newest first; resets when the step changes (a new process started).
  const [detailLog, setDetailLog] = useState<string[]>([]);
  const lastDetailRef = useRef<string | null>(null);
  const lastStepRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastStepRef.current !== progress.step) {
      lastStepRef.current = progress.step;
      lastDetailRef.current = null;
      setDetailLog([]);
    }
    const d = progress.detail?.trim();
    if (d && d !== lastDetailRef.current) {
      lastDetailRef.current = d;
      setDetailLog((prev) => [d, ...prev].slice(0, 8));
    }
  }, [progress.step, progress.detail]);

  return (
    <div className="space-y-3">
      <div className="flex gap-4 items-stretch">
        {isRunning && (
          <NowScanningTile
            item={progress.currentItem ?? null}
            kind={progress.currentItemKind}
            library={progress.currentItemLibrary}
          />
        )}
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <div className="flex items-baseline gap-2 mb-1">
            {progress.stepIndex !== undefined && progress.stepTotal !== undefined && (
              <span className="text-[10px] uppercase tracking-wider text-emerald-400 bg-emerald-950/40 ring-1 ring-emerald-900/40 rounded px-1.5 py-0.5">
                {progress.stepIndex}/{progress.stepTotal}
              </span>
            )}
            <span className="text-sm font-medium text-zinc-100">{progress.step}</span>
            {progress.label && (
              <span className="text-xs text-zinc-400 truncate">· {progress.label}</span>
            )}
          </div>
          {pct !== null && (
            <>
              <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-[width] duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
                {progress.current} / {progress.total}
                <span className="text-zinc-600 ml-1">({pct.toFixed(1)}%)</span>
                {remaining !== null && (
                  <span className="text-zinc-600 ml-2">
                    — {remaining.toLocaleString()} to go
                  </span>
                )}
              </div>
            </>
          )}
          {pct === null && typeof progress.current === 'number' && (
            <div className="text-[11px] text-zinc-500 tabular-nums">
              {progress.current.toLocaleString()} processed
            </div>
          )}
          {progress.currentItem && (
            <div
              className="mt-1.5 text-[10px] text-zinc-600 truncate font-mono"
              title={progress.currentItem}
            >
              {labelFor(progress.currentItem, progress.currentItemKind)}
            </div>
          )}
        </div>
      </div>

      {detailLog.length > 0 && (
        <div className="rounded-lg bg-zinc-950/60 ring-1 ring-zinc-800 p-3 max-h-44 overflow-y-auto">
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5">
            Recognized text
          </div>
          <ul className="space-y-1">
            {detailLog.map((line, i) => (
              <li
                key={`${i}-${line.slice(0, 12)}`}
                className={`text-xs font-mono leading-snug break-words
                            ${i === 0 ? 'text-zinc-200' : 'text-zinc-500'}`}
              >
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recent.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600 shrink-0 pr-1">
            recent
          </span>
          {recent.map((item, idx) => (
            <RecentTile key={`${item.item}-${item.at}`} item={item} ageRank={idx} />
          ))}
        </div>
      )}
    </div>
  );
}

function NowScanningTile({
  item,
  kind,
  library,
}: {
  item: string | null;
  kind: 'uuid' | 'path' | undefined;
  library: string | undefined;
}) {
  const thumbUrl =
    item && kind === 'uuid' && library
      ? `/api/thumbnails/${encodeURIComponent(item)}?lib=${encodeURIComponent(library)}`
      : null;
  const href = previewHref(item, kind, library);

  const tileClass =
    'relative w-44 h-44 shrink-0 rounded-xl overflow-hidden bg-zinc-900 ring-1 ring-emerald-700/50 shadow-[0_0_28px_-4px_rgba(16,185,129,0.45)]';
  const inner = (
    <>
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={item}
          src={thumbUrl}
          alt=""
          className="w-full h-full object-cover"
        />
      ) : (
        <FileIconPlaceholder />
      )}
      <div
        className="absolute inset-x-0 top-0 h-2 pointer-events-none kn-scan-bar"
        style={{
          background:
            'linear-gradient(180deg, rgba(16,185,129,0) 0%, rgba(16,185,129,0.9) 50%, rgba(16,185,129,0) 100%)',
          boxShadow: '0 0 12px 2px rgba(16,185,129,0.7)',
        }}
      />
      {href && <OpenInNewTabOverlay />}
    </>
  );

  if (!href) return <div className={tileClass}>{inner}</div>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open this item in a new tab"
      className={`${tileClass} group block cursor-pointer`}
    >
      {inner}
    </a>
  );
}

function RecentTile({ item, ageRank }: { item: RecentItem; ageRank: number }) {
  // Fade older items so the eye is pulled to the most recent ones.
  const opacity = Math.max(0.35, 1 - ageRank * 0.08);
  const thumbUrl =
    item.kind === 'uuid' && item.library
      ? `/api/thumbnails/${encodeURIComponent(item.item)}?lib=${encodeURIComponent(item.library)}`
      : null;
  const title = labelFor(item.item, item.kind);
  const href = previewHref(item.item, item.kind, item.library);

  const tileClass =
    'relative w-24 h-24 shrink-0 rounded-lg overflow-hidden bg-zinc-900 ring-1 ring-zinc-800 transition-opacity';
  const inner = thumbUrl ? (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
      {href && <OpenInNewTabOverlay />}
    </>
  ) : (
    <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-600 font-mono text-center px-1.5 break-all leading-tight">
      {title.slice(0, 28)}
    </div>
  );

  if (!href) {
    return (
      <div className={tileClass} style={{ opacity }} title={title}>
        {inner}
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${tileClass} group block cursor-pointer`}
      style={{ opacity }}
      title={`${title} — open in new tab`}
    >
      {inner}
    </a>
  );
}

function FileIconPlaceholder() {
  return (
    <div className="w-full h-full flex items-center justify-center">
      <svg width="40" height="48" viewBox="0 0 24 28" className="text-zinc-700">
        <path d="M3 1h13l5 5v21H3z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M16 1v5h5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function labelFor(item: string, kind: 'uuid' | 'path' | undefined): string {
  if (kind === 'path') {
    const i = Math.max(item.lastIndexOf('/'), item.lastIndexOf('\\'));
    return i >= 0 ? item.slice(i + 1) : item;
  }
  return item;
}

/**
 * Link to open an item inside the KenNook app in a new tab. Only resolvable
 * once the item exists in the library DB (kind === 'uuid'); path items
 * mid-indexing have no row yet, so they aren't linkable.
 *
 * `lib` selects the library (the client forwards it as the x-kennook-library
 * header), `q=<uuid>` triggers asset-ID search so the single item loads into
 * the results, and `item=<uuid>` opens its preview viewer on top.
 */
function previewHref(
  item: string | null,
  kind: 'uuid' | 'path' | undefined,
  library: string | undefined,
): string | null {
  if (!item || kind !== 'uuid' || !library) return null;
  const params = new URLSearchParams({ lib: library, q: item, item });
  return `/?${params.toString()}`;
}

/** Hover affordance signalling a tile is a click-through link. The parent
 *  anchor carries `group`; this dims the tile and reveals an external-link
 *  glyph on hover. pointer-events-none so it never eats the click. */
function OpenInNewTabOverlay() {
  return (
    <div className="absolute inset-0 pointer-events-none flex items-center justify-center
                    bg-black/0 group-hover:bg-black/40 transition-colors">
      <span className="opacity-0 group-hover:opacity-100 transition-opacity
                       text-zinc-100 drop-shadow">
        <ExternalLinkIcon />
      </span>
    </div>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
