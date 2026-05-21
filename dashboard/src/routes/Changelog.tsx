import { useMemo, useState } from 'react';
import { CHANGELOG, type ChangelogCategory, type ChangelogEntry } from '../data/changelog';

const CATEGORY_LABELS: Record<ChangelogCategory, string> = {
  feature: 'feature',
  fix: 'fix',
  config: 'config',
  engine: 'engine',
  ui: 'ui',
  infra: 'infra',
};

// Terminal-aesthetic colors per category. Subtle by design — the title text is
// the focus; the badge is just a quick visual sort.
const CATEGORY_CLASSES: Record<ChangelogCategory, string> = {
  feature: 'text-hi border-hi/40',
  fix:     'text-amber border-amber/40',
  config:  'text-mid border-mid/40',
  engine:  'text-mid border-mid/40',
  ui:      'text-hi border-hi/40',
  infra:   'text-dim border-dim/40',
};

const ALL_CATEGORIES: ChangelogCategory[] = ['feature', 'fix', 'config', 'engine', 'ui', 'infra'];

export default function Changelog() {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<ChangelogCategory | 'all'>('all');

  const visible = useMemo(
    () => (filter === 'all' ? CHANGELOG : CHANGELOG.filter((e) => e.category === filter)),
    [filter],
  );

  function toggle(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <div className="p-3 md:p-6">
      <div className="mb-4">
        <div className="text-dim text-[10px] tracking-[0.3em]">/// LOG</div>
        <h1 className="text-hi text-[20px] md:text-[24px] font-bold tracking-wider mt-1">
          Changelog
        </h1>
        <div className="text-dim text-[11px] mt-1">
          Hand-curated history of every shipped change. Newest first.
        </div>
      </div>

      {/* filter chips */}
      <div className="flex flex-wrap gap-1.5 mb-4 text-[10px]">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          [all]
        </FilterChip>
        {ALL_CATEGORIES.map((c) => (
          <FilterChip key={c} active={filter === c} onClick={() => setFilter(c)}>
            [{CATEGORY_LABELS[c]}]
          </FilterChip>
        ))}
      </div>

      <div className="border border-border rounded-sm divide-y divide-border">
        {visible.map((entry, i) => (
          <EntryRow
            key={`${entry.date}-${i}`}
            entry={entry}
            expanded={expanded.has(i)}
            onToggle={() => toggle(i)}
          />
        ))}
        {visible.length === 0 && (
          <div className="px-4 py-6 text-dim text-[12px] text-center">
            no entries in this filter
          </div>
        )}
      </div>

      <div className="text-dim text-[10px] mt-6 leading-relaxed">
        <span className="text-mid">// note</span> · this changelog tracks human-visible changes only.
        bot state-update commits (the every-10-minute jsonl pushes) are NOT included by design —
        they're data, not changes.
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded-sm tracking-wider ${
        active ? 'text-hi border border-hi/40 bg-hi/5' : 'text-dim border border-border'
      }`}
    >
      {children}
    </button>
  );
}

function EntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ChangelogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasDetails = !!entry.details;
  return (
    <div>
      <button
        type="button"
        onClick={hasDetails ? onToggle : undefined}
        className={`w-full text-left px-3 md:px-4 py-2.5 flex items-start gap-3 ${
          hasDetails ? 'hover:bg-panel/30' : 'cursor-default'
        }`}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        {/* expand caret (or spacer if no details) */}
        <span className="text-dim text-[10px] mt-0.5 w-3 shrink-0 tnum">
          {hasDetails ? (expanded ? '▾' : '▸') : ' '}
        </span>

        {/* date */}
        <span className="text-dim text-[11px] mt-0.5 w-[78px] shrink-0 tnum">{entry.date}</span>

        {/* category badge */}
        <span
          className={`text-[9px] tracking-widest px-1.5 py-0.5 border rounded-sm shrink-0 mt-0.5 ${
            CATEGORY_CLASSES[entry.category]
          }`}
        >
          {CATEGORY_LABELS[entry.category]}
        </span>

        {/* title */}
        <span className="text-fg text-[12px] flex-1 leading-snug">{entry.title}</span>
      </button>

      {hasDetails && expanded && (
        <div className="px-3 md:px-4 pb-3 pl-[120px] text-dim text-[11px] leading-relaxed whitespace-pre-wrap">
          {entry.details}
        </div>
      )}
    </div>
  );
}
