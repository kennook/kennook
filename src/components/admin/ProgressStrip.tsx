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

import type { ProgressPayload, RecentItem } from '@/server/admin/progress-protocol';

export function ProgressStrip({
  progress,
  recent,
}: {
  progress: ProgressPayload;
  recent: RecentItem[];
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

  return (
    <div className="space-y-3">
      <div className="flex gap-4 items-stretch">
        <NowScanningTile
          item={progress.currentItem ?? null}
          kind={progress.currentItemKind}
          workspace={progress.currentItemWorkspace}
        />
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
  workspace,
}: {
  item: string | null;
  kind: 'uuid' | 'path' | undefined;
  workspace: string | undefined;
}) {
  const thumbUrl =
    item && kind === 'uuid' && workspace
      ? `/api/thumbnails/${encodeURIComponent(item)}?ws=${encodeURIComponent(workspace)}`
      : null;

  return (
    <div className="relative w-28 h-28 shrink-0 rounded-lg overflow-hidden bg-zinc-900 ring-1 ring-emerald-700/50 shadow-[0_0_20px_-4px_rgba(16,185,129,0.4)]">
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
    </div>
  );
}

function RecentTile({ item, ageRank }: { item: RecentItem; ageRank: number }) {
  // Fade older items so the eye is pulled to the most recent ones.
  const opacity = Math.max(0.35, 1 - ageRank * 0.08);
  const thumbUrl =
    item.kind === 'uuid' && item.workspace
      ? `/api/thumbnails/${encodeURIComponent(item.item)}?ws=${encodeURIComponent(item.workspace)}`
      : null;
  const title = labelFor(item.item, item.kind);

  return (
    <div
      className="w-14 h-14 shrink-0 rounded overflow-hidden bg-zinc-900 ring-1 ring-zinc-800 transition-opacity"
      style={{ opacity }}
      title={title}
    >
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[8px] text-zinc-600 font-mono text-center px-1 break-all leading-tight">
          {title.slice(0, 16)}
        </div>
      )}
    </div>
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
