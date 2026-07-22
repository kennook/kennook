'use client';

/**
 * Left pane of the Disk-Utility-style storage admin: the list of drives,
 * grouped Internal / External / Cloud, each a selectable row with a status dot
 * and a mini used/free capacity bar. Selecting one drives the detail pane.
 */

import type { StorageInfo } from '@/server/storage';

export type Group = 'Internal' | 'External' | 'Cloud';

export function groupFor(d: StorageInfo): Group {
  if (d.type !== 'local') return 'Cloud';
  // macOS mounts external volumes under /Volumes; the boot disk is elsewhere.
  return d.root_path.startsWith('/Volumes/') ? 'External' : 'Internal';
}

// ── Icons ──
export function DriveGlyph({ group, size = 15 }: { group: Group; size?: number }) {
  if (group === 'Cloud') return <CloudIcon size={size} />;
  if (group === 'External') return <ExternalDriveIcon size={size} />;
  return <InternalDiskIcon size={size} />;
}

function InternalDiskIcon({ size }: { size: number }) {
  // Stacked internal disk.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
      <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
    </svg>
  );
}
function Spinner() {
  // Small emerald activity spinner shown while a job runs on the drive.
  return (
    <span
      className="shrink-0 ml-auto w-3 h-3 rounded-full border-[1.5px] border-emerald-400/30 border-t-emerald-400 animate-spin"
      title="A job is running on this drive"
      aria-label="Working"
    />
  );
}
function ExternalDriveIcon({ size }: { size: number }) {
  // External hard drive (horizontal enclosure + activity dot).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="8" width="18" height="8" rx="2" />
      <path d="M7 12h6" />
      <circle cx="17" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function CloudIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.5 18a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.34 10 3.5 3.5 0 0 0 7 18h10.5z" />
    </svg>
  );
}
function GroupIcon({ group }: { group: Group }) {
  return <span className="text-zinc-600"><DriveGlyph group={group} size={12} /></span>;
}

export function DriveSidebar({
  drives,
  selectedId,
  onSelect,
  activeStorageIds,
}: {
  drives: StorageInfo[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Drives with a running/queued job — shown with an activity spinner. */
  activeStorageIds?: Set<number>;
}) {
  const groups: Group[] = ['Internal', 'External', 'Cloud'];
  return (
    <nav className="w-60 shrink-0 space-y-4">
      {groups.map((g) => {
        const items = drives.filter((d) => groupFor(d) === g);
        if (items.length === 0) return null;
        return (
          <div key={g}>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-600 px-2 mb-1">
              <GroupIcon group={g} />
              {g}
            </div>
            <div className="space-y-0.5">
              {items.map((d) => (
                <DriveRow
                  key={d.id}
                  drive={d}
                  active={d.id === selectedId}
                  busy={activeStorageIds?.has(d.id) ?? false}
                  onClick={() => onSelect(d.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function DriveRow({ drive, active, busy, onClick }: { drive: StorageInfo; active: boolean; busy: boolean; onClick: () => void }) {
  // The drive glyph is tinted by status (online/offline/cloud) so it doubles as
  // the status indicator — no separate dot needed.
  const iconClass =
    drive.exists === null ? 'text-zinc-400'
      : drive.exists ? 'text-emerald-400'
        : 'text-red-400';
  const cap = drive.capacity_bytes;
  const free = drive.free_bytes;
  const usedPct = cap != null && cap > 0 && free != null
    ? Math.max(2, Math.min(100, ((cap - free) / cap) * 100))
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-md px-2.5 py-2 transition ring-1
        ${active ? 'bg-zinc-800 ring-zinc-700' : 'ring-transparent hover:bg-zinc-900'}`}
    >
      <div className="flex items-center gap-2">
        {/* While a job runs on this drive, pulse the glyph so it reads as "busy". */}
        <span className={`shrink-0 ${iconClass} ${busy ? 'animate-pulse' : ''}`}>
          <DriveGlyph group={groupFor(drive)} />
        </span>
        <span className={`text-sm truncate ${active ? 'text-zinc-100' : 'text-zinc-300'}`}>{drive.name}</span>
        {busy && <Spinner />}
      </div>
      {usedPct != null ? (
        <div className="mt-1.5 ml-[1.6rem]">
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-zinc-500" style={{ width: `${usedPct}%` }} />
          </div>
        </div>
      ) : (
        <div className="mt-0.5 ml-[1.6rem] text-[10px] text-zinc-600 tabular-nums">
          {drive.file_count.toLocaleString()} items
        </div>
      )}
    </button>
  );
}
