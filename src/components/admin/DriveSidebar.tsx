'use client';

/**
 * Left pane of the Disk-Utility-style storage admin: the list of drives,
 * grouped Internal / External / Cloud, each a selectable row with a status dot
 * and a mini used/free capacity bar. Selecting one drives the detail pane.
 */

import type { StorageInfo } from '@/server/storage';

type Group = 'Internal' | 'External' | 'Cloud';

function groupFor(d: StorageInfo): Group {
  if (d.type !== 'local') return 'Cloud';
  // macOS mounts external volumes under /Volumes; the boot disk is elsewhere.
  return d.root_path.startsWith('/Volumes/') ? 'External' : 'Internal';
}

export function DriveSidebar({
  drives,
  selectedId,
  onSelect,
}: {
  drives: StorageInfo[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const groups: Group[] = ['Internal', 'External', 'Cloud'];
  return (
    <nav className="w-60 shrink-0 space-y-4">
      {groups.map((g) => {
        const items = drives.filter((d) => groupFor(d) === g);
        if (items.length === 0) return null;
        return (
          <div key={g}>
            <div className="text-[10px] uppercase tracking-wider text-zinc-600 px-2 mb-1">{g}</div>
            <div className="space-y-0.5">
              {items.map((d) => (
                <DriveRow key={d.id} drive={d} active={d.id === selectedId} onClick={() => onSelect(d.id)} />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function DriveRow({ drive, active, onClick }: { drive: StorageInfo; active: boolean; onClick: () => void }) {
  const dotClass =
    drive.exists === null ? 'bg-zinc-500'
      : drive.exists ? 'bg-emerald-400'
        : 'bg-red-400';
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
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
        <span className={`text-sm truncate ${active ? 'text-zinc-100' : 'text-zinc-300'}`}>{drive.name}</span>
      </div>
      {usedPct != null ? (
        <div className="mt-1.5 ml-4">
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-zinc-500" style={{ width: `${usedPct}%` }} />
          </div>
        </div>
      ) : (
        <div className="mt-0.5 ml-4 text-[10px] text-zinc-600 tabular-nums">
          {drive.file_count.toLocaleString()} items
        </div>
      )}
    </button>
  );
}
