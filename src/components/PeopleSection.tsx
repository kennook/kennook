'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';

interface Props {
  activePersonUuid: string | null;
  onSelectPerson: (uuid: string | null) => void;
}

// 4 columns × 4 rows = 16 people visible before "show more" — comfortable
// scan range for the most-frequent faces without dominating the sidebar.
const COLLAPSED_LIMIT = 16;

/**
 * Sidebar section for people (face clusters). Pure thumbnail grid —
 * names live in the title tooltip rather than crowding the layout,
 * since most clusters stay unnamed in practice. The header rename
 * affordance (in the page-level person header above the grid) is still
 * the place to label anyone the user actually cares to identify.
 */
export function PeopleSection({ activePersonUuid, onSelectPerson }: Props) {
  const [expanded, setExpanded] = useState(false);
  const people = trpc.people.list.useQuery();

  if (people.isLoading) {
    return (
      <section className="mb-5">
        <SectionHeader />
        <div className="px-3 py-1.5 text-sm text-zinc-500">Loading…</div>
      </section>
    );
  }
  if (!people.data || people.data.length === 0) {
    return (
      <section className="mb-5">
        <SectionHeader />
        <div className="px-3 py-1.5 text-xs text-zinc-600 leading-relaxed">
          Run <span className="font-mono">pnpm enrich:faces</span> then{' '}
          <span className="font-mono">pnpm enrich:people</span> to populate.
        </div>
      </section>
    );
  }

  const list = people.data;
  const visible = expanded ? list : list.slice(0, COLLAPSED_LIMIT);
  const remaining = list.length - visible.length;

  return (
    <section className="mb-5">
      <SectionHeader
        clearable={activePersonUuid !== null}
        onClear={() => onSelectPerson(null)}
      />
      <div className="grid grid-cols-4 gap-1.5 px-3">
        {visible.map((p) => {
          const active = p.uuid === activePersonUuid;
          // Native tooltip — name if labeled, otherwise just the count.
          const tooltip = p.name
            ? `${p.name} · ${p.faceCount} face${p.faceCount === 1 ? '' : 's'}`
            : `${p.faceCount} face${p.faceCount === 1 ? '' : 's'}`;
          return (
            <button
              key={p.uuid}
              onClick={() => onSelectPerson(active ? null : p.uuid)}
              title={tooltip}
              aria-label={tooltip}
              className={`relative aspect-square rounded-full overflow-hidden bg-zinc-900
                          transition outline-none
                          ${active
                            ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-zinc-950'
                            : 'hover:ring-2 hover:ring-zinc-700'}`}
            >
              {p.coverThumbnailUrl && (
                <img
                  src={p.coverThumbnailUrl}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover"
                />
              )}
            </button>
          );
        })}
      </div>
      {remaining > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-zinc-500 hover:text-zinc-300 px-3 py-1 mt-1.5 text-left"
        >
          + {remaining} more
        </button>
      )}
    </section>
  );
}

function SectionHeader({
  clearable = false,
  onClear,
}: {
  clearable?: boolean;
  onClear?: () => void;
}) {
  return (
    <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 px-3 mb-1.5
                   flex items-center justify-between">
      <span>People</span>
      {clearable && (
        <button
          onClick={onClear}
          className="text-zinc-500 hover:text-zinc-300 normal-case tracking-normal
                     text-xs lowercase"
        >
          exit
        </button>
      )}
    </h3>
  );
}
