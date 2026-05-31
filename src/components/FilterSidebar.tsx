'use client';

import { useState } from 'react';
import { likeFillColor } from '@/lib/like-colors';

export type Orientation = 'portrait' | 'landscape' | 'square';
export type Kind = 'photo' | 'video';
export type Watched = 'watched' | 'unwatched';
export type SensitiveFilter = 'hide' | 'only';

export interface FacetCounts {
  kinds: Array<{ value: 'photo' | 'video'; count: number }>;
  orientations: Array<{ value: 'portrait' | 'landscape' | 'square'; count: number }>;
  cameras: Array<{ value: string; count: number }>;
  years: Array<{ value: number; count: number }>;
  tags: Array<{ value: string; count: number }>;
  mentioned: Array<{ value: string; count: number }>;
}

interface Props {
  facets: FacetCounts | null;
  loading?: boolean;

  kind: Kind | null;
  onKindChange: (v: Kind | null) => void;

  orientation: Orientation | null;
  onOrientationChange: (v: Orientation | null) => void;

  cameraMake: string | null;
  onCameraChange: (v: string | null) => void;

  year: number | null;
  onYearChange: (v: number | null) => void;

  tags: string[];
  onTagsChange: (v: string[]) => void;

  mentioned: string[];
  onMentionedChange: (v: string[]) => void;

  minLikes: number | null;
  onMinLikesChange: (v: number | null) => void;

  watched: Watched | null;
  onWatchedChange: (v: Watched | null) => void;

  sensitive: SensitiveFilter | null;
  onSensitiveChange: (v: SensitiveFilter | null) => void;
}

const ORIENTATION_LABELS: Record<Orientation, string> = {
  portrait: 'Portrait',
  landscape: 'Landscape',
  square: 'Square',
};

export function FilterSidebar({
  facets,
  loading,
  kind, onKindChange,
  orientation, onOrientationChange,
  cameraMake, onCameraChange,
  year, onYearChange,
  tags, onTagsChange,
  mentioned, onMentionedChange,
  minLikes, onMinLikesChange,
  watched, onWatchedChange,
  sensitive, onSensitiveChange,
}: Props) {
  const hasAnyActive =
    kind !== null ||
    orientation !== null ||
    cameraMake !== null ||
    year !== null ||
    tags.length > 0 ||
    mentioned.length > 0 ||
    minLikes !== null ||
    watched !== null ||
    sensitive !== null;

  const resetAll = () => {
    onKindChange(null);
    onOrientationChange(null);
    onCameraChange(null);
    onYearChange(null);
    onTagsChange([]);
    onMentionedChange([]);
    onMinLikesChange(null);
    onWatchedChange(null);
    onSensitiveChange(null);
  };

  const toggleTag = (t: string) => {
    if (tags.includes(t)) onTagsChange(tags.filter((x) => x !== t));
    else onTagsChange([...tags, t]);
  };

  const toggleMentioned = (t: string) => {
    if (mentioned.includes(t)) onMentionedChange(mentioned.filter((x) => x !== t));
    else onMentionedChange([...mentioned, t]);
  };

  return (
    <aside
      className="hidden md:block w-56 shrink-0 sticky top-20 self-start
                 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2"
    >
      <FilterSection title="Type">
        <FilterRow
          active={kind === null}
          onClick={() => onKindChange(null)}
        >
          All
        </FilterRow>
        {(['photo', 'video'] as const).map((k) => {
          const count = facets?.kinds.find((c) => c.value === k)?.count ?? 0;
          if (count === 0 && kind !== k) return null;
          return (
            <FilterRow
              key={k}
              active={kind === k}
              count={count}
              onClick={() => onKindChange(k)}
            >
              {k === 'photo' ? 'Photos' : 'Videos'}
            </FilterRow>
          );
        })}
      </FilterSection>

      <FilterSection title="Watched">
        <div className="px-3">
          <div className="flex rounded-lg ring-1 ring-zinc-800 overflow-hidden">
            <WatchedSeg
              active={watched === null}
              onClick={() => onWatchedChange(null)}
              label="All"
            />
            <WatchedSeg
              active={watched === 'unwatched'}
              onClick={() => onWatchedChange('unwatched')}
              label="Unwatched"
              icon={<EyeOffIcon />}
              tone="amber"
            />
            <WatchedSeg
              active={watched === 'watched'}
              onClick={() => onWatchedChange('watched')}
              label="Watched"
              icon={<EyeIcon />}
              tone="emerald"
            />
          </div>
        </div>
      </FilterSection>

      <FilterSection title="Sensitive">
        <FilterRow
          active={sensitive === null}
          onClick={() => onSensitiveChange(null)}
        >
          All
        </FilterRow>
        <FilterRow
          active={sensitive === 'hide'}
          onClick={() => onSensitiveChange('hide')}
        >
          Hide sensitive
        </FilterRow>
        <FilterRow
          active={sensitive === 'only'}
          onClick={() => onSensitiveChange('only')}
        >
          Only sensitive
        </FilterRow>
      </FilterSection>

      <FilterSection title="Likes">
        <LikeSlider value={minLikes} onChange={onMinLikesChange} />
      </FilterSection>

      <FilterSection title="Orientation">
        <FilterRow
          active={orientation === null}
          onClick={() => onOrientationChange(null)}
        >
          All
        </FilterRow>
        {(['portrait', 'landscape', 'square'] as const).map((o) => {
          const count = facets?.orientations.find((c) => c.value === o)?.count ?? 0;
          if (count === 0 && orientation !== o) return null;
          return (
            <FilterRow
              key={o}
              active={orientation === o}
              count={count}
              icon={<OrientationIcon kind={o} />}
              onClick={() => onOrientationChange(o)}
            >
              {ORIENTATION_LABELS[o]}
            </FilterRow>
          );
        })}
      </FilterSection>

      <DynamicFilterSection
        title="Camera"
        options={facets?.cameras ?? []}
        selected={cameraMake}
        onSelect={onCameraChange}
        loading={loading}
      />

      <DynamicFilterSection
        title="Year"
        options={facets?.years ?? []}
        selected={year}
        onSelect={onYearChange}
        loading={loading}
        formatValue={(v) => String(v)}
      />

      <TagFilterSection
        title="Tags"
        options={facets?.tags ?? []}
        selected={tags}
        onToggle={toggleTag}
        loading={loading}
      />

      <TagFilterSection
        title="Mentioned"
        hint="Heard in the audio"
        accent="sky"
        rowIcon={<SpeechIcon />}
        options={facets?.mentioned ?? []}
        selected={mentioned}
        onToggle={toggleMentioned}
        loading={loading}
      />

      {hasAnyActive && (
        <button
          onClick={resetAll}
          className="text-xs text-zinc-500 hover:text-zinc-300 px-3 mt-3 transition"
        >
          Reset all filters
        </button>
      )}
    </aside>
  );
}

// ─── Sections ───────────────────────────────────────────────────────────

function FilterSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 px-3 mb-1.5">
        {title}
        {hint && (
          <span className="ml-1.5 normal-case tracking-normal text-zinc-600">· {hint}</span>
        )}
      </h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

interface DynamicSectionProps<T> {
  title: string;
  options: Array<{ value: T; count: number }>;
  selected: T | null;
  onSelect: (v: T | null) => void;
  loading?: boolean;
  formatValue?: (v: T) => string;
}

function DynamicFilterSection<T>({
  title,
  options,
  selected,
  onSelect,
  loading,
  formatValue,
}: DynamicSectionProps<T>) {
  const [expanded, setExpanded] = useState(false);
  const MAX_COLLAPSED = 5;

  if (options.length === 0 && selected === null && !loading) return null;

  const visible = expanded ? options : options.slice(0, MAX_COLLAPSED);
  const remaining = options.length - visible.length;

  return (
    <FilterSection title={title}>
      {selected !== null && (
        <FilterRow active onClick={() => onSelect(null)} icon={<ClearIcon />}>
          {formatValue ? formatValue(selected) : String(selected)}
        </FilterRow>
      )}
      {visible.map(({ value, count }) => {
        if (value === selected) return null;
        return (
          <FilterRow
            key={String(value)}
            active={false}
            count={count}
            onClick={() => onSelect(value)}
          >
            {formatValue ? formatValue(value) : String(value)}
          </FilterRow>
        );
      })}
      {remaining > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-zinc-500 hover:text-zinc-300 px-3 py-1 mt-0.5 text-left"
        >
          + {remaining} more
        </button>
      )}
    </FilterSection>
  );
}

function TagFilterSection({
  title,
  hint,
  accent = 'emerald',
  rowIcon,
  options,
  selected,
  onToggle,
  loading,
}: {
  title: string;
  hint?: string;
  accent?: 'emerald' | 'sky';
  /** Optional glyph rendered on each row — e.g. a speech bubble for "said". */
  rowIcon?: React.ReactNode;
  options: Array<{ value: string; count: number }>;
  selected: string[];
  onToggle: (t: string) => void;
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const MAX_COLLAPSED = 8;

  if (options.length === 0 && selected.length === 0 && !loading) return null;

  // Show selected tags first even if they're not in the current top-N.
  const selectedSet = new Set(selected);
  const inOptions = options.filter((o) => !selectedSet.has(o.value));
  const selectedAsOptions = selected.map((t) => ({
    value: t,
    count: options.find((o) => o.value === t)?.count ?? 0,
  }));
  const all = [...selectedAsOptions, ...inOptions];
  const visible = expanded ? all : all.slice(0, MAX_COLLAPSED);
  const remaining = all.length - visible.length;

  return (
    <FilterSection title={title} hint={hint}>
      {visible.map(({ value, count }) => (
        <FilterCheckRow
          key={value}
          checked={selectedSet.has(value)}
          count={count}
          accent={accent}
          icon={rowIcon}
          onChange={() => onToggle(value)}
        >
          {value}
        </FilterCheckRow>
      ))}
      {remaining > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-zinc-500 hover:text-zinc-300 px-3 py-1 mt-0.5 text-left"
        >
          + {remaining} more
        </button>
      )}
    </FilterSection>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────────

function FilterRow({
  active,
  icon,
  count,
  onClick,
  children,
}: {
  active: boolean;
  icon?: React.ReactNode;
  count?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 rounded text-sm flex items-center gap-2.5
                  transition
                  ${active
                    ? 'bg-zinc-800/80 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60'}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors
                    ${active ? 'bg-emerald-400' : 'bg-zinc-700'}`}
      />
      {icon && <span className="text-zinc-500 shrink-0">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="text-xs text-zinc-500 tabular-nums shrink-0">{count}</span>
      )}
    </button>
  );
}

function FilterCheckRow({
  checked,
  count,
  onChange,
  children,
  accent = 'emerald',
  icon,
}: {
  checked: boolean;
  count?: number;
  onChange: () => void;
  children: React.ReactNode;
  accent?: 'emerald' | 'sky';
  icon?: React.ReactNode;
}) {
  const checkedBox = accent === 'sky'
    ? 'bg-sky-400 border-sky-400'
    : 'bg-emerald-400 border-emerald-400';
  const iconTint = accent === 'sky' ? 'text-sky-400/80' : 'text-zinc-500';
  return (
    <button
      onClick={onChange}
      className={`w-full text-left px-3 py-1.5 rounded text-sm flex items-center gap-2.5
                  transition
                  ${checked
                    ? 'bg-zinc-800/80 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60'}`}
    >
      <span
        className={`w-3 h-3 rounded border shrink-0 flex items-center justify-center
                    transition-colors
                    ${checked ? checkedBox : 'border-zinc-600 bg-transparent'}`}
      >
        {checked && (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="black" strokeWidth="2">
            <path d="M2 5 L4 7 L8 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {icon && <span className={`shrink-0 ${iconTint}`}>{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="text-xs text-zinc-500 tabular-nums shrink-0">{count}</span>
      )}
    </button>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────────

function OrientationIcon({ kind }: { kind: Orientation }) {
  if (kind === 'portrait') return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="5" y="2" width="6" height="12" rx="1" />
    </svg>
  );
  if (kind === 'landscape') return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="5" width="12" height="6" rx="1" />
    </svg>
  );
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="10" height="10" rx="1" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
    </svg>
  );
}

// Speech bubble — marks "Mentioned" (said-in-audio) tags, echoing the sky-blue
// "said" badge on search-result cards.
function SpeechIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 4v6a1.5 1.5 0 0 1-1.5 1.5H6l-3 2.5v-2.5H3.5A1.5 1.5 0 0 1 2 10z" strokeLinejoin="round" />
    </svg>
  );
}

// Segmented control for the Watched filter — All / Unwatched / Watched, each
// with an icon so the active facet is unmistakable at a glance.
function WatchedSeg({
  active, onClick, label, icon, tone = 'zinc',
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  tone?: 'zinc' | 'amber' | 'emerald';
}) {
  const activeBg =
    tone === 'amber' ? 'bg-amber-600 text-amber-50'
    : tone === 'emerald' ? 'bg-emerald-600 text-emerald-50'
    : 'bg-zinc-700 text-zinc-100';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`${label}${label === 'All' ? '' : ' only'}`}
      className={`flex-1 min-w-0 flex items-center justify-center gap-1 px-1.5 py-1.5
                  text-[11px] leading-none transition border-r border-zinc-800 last:border-r-0
                  ${active ? activeBg : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0">
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0">
      <path d="M6.3 3.3A6.8 6.8 0 0 1 8 3.5c4.5 0 7 4.5 7 4.5a12 12 0 0 1-2 2.5M3.6 4.6A12 12 0 0 0 1 8s2.5 4.5 7 4.5a6.6 6.6 0 0 0 2.4-.45" strokeLinecap="round" />
      <path d="M2 2l12 12" strokeLinecap="round" />
    </svg>
  );
}

function HeartChip({ count = 1, filled = true, size = 11 }: { count?: number; filled?: boolean; size?: number }) {
  // Per-position shade so the filling row reads pale→vivid — doubles as a
  // legend for the rating colors used on cards + in the viewer.
  const c = filled ? likeFillColor(count) : null;
  const color = c ?? 'transparent';
  const stroke = c ?? 'rgba(255,255,255,0.35)';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={color} stroke={stroke} strokeWidth="1.3" strokeLinejoin="round">
      <path d="M8 14s-5-3.5-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.5-5 7-5 7z" />
    </svg>
  );
}

/**
 * Kayak-style slider for the "minimum likes" filter. 6 stops (Any + 1–5);
 * filled track + hearts visualization above. Native range input under the
 * hood so we get free keyboard support (←/→/Home/End) and accessibility.
 */
function LikeSlider({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const MAX = 5;
  const sliderValue = value ?? 0;
  const fillPct = (sliderValue / MAX) * 100;

  return (
    <div className="px-3 pb-1">
      <div className="flex items-center justify-between mb-1.5 min-h-[18px]">
        <span className="text-xs text-zinc-300">
          {sliderValue === 0 ? (
            <span className="text-zinc-500">Any</span>
          ) : sliderValue === MAX ? (
            <>Top picks</>
          ) : (
            <>{sliderValue}+ likes</>
          )}
        </span>
        <div className="flex gap-0.5">
          {Array.from({ length: MAX }).map((_, i) => (
            <HeartChip key={i} count={i + 1} filled={i < sliderValue} size={10} />
          ))}
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={MAX}
        step={1}
        value={sliderValue}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          onChange(n === 0 ? null : n);
        }}
        className="kn-slider"
        style={{ ['--fill' as string]: `${fillPct}%` }}
        aria-label="Minimum likes"
      />

      <div className="flex justify-between mt-0.5 text-[9px] text-zinc-600 select-none px-[2px]">
        <span>Any</span>
        <span>1</span>
        <span>2</span>
        <span>3</span>
        <span>4</span>
        <span>5</span>
      </div>
    </div>
  );
}
