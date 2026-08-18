// Grouped sidebar navigation with a flyout panel.
//
// One state machine (`openGroup`), one panel in the DOM, two presentations
// driven purely by CSS breakpoints:
//   • Desktop — the panel floats beside the sidebar rail (md:absolute left-full).
//   • Phone   — the nav list hides and the panel takes its place in flow, with
//               a back row: a drill-down. An absolutely-positioned flyout would
//               be clipped by the drawer's own overflow scroll, and off-canvas
//               popovers are awkward on touch anyway.
//
// The panel is deliberately NOT rendered twice (once per breakpoint): that
// duplicates every link and, worse, duplicates the panel's id.

import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  NAV,
  isGroup,
  matchesLeaf,
  groupContaining,
  type NavGroup,
  type NavLeaf,
} from '../../lib/nav-items';

export default function NavMenu({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const activeGroup = groupContaining(location.pathname);

  // Close the panel whenever the route changes — otherwise it stays open over
  // the page you just navigated to.
  useEffect(() => { setOpenGroup(null); }, [location.pathname]);

  // Escape dismisses the panel, an outside click closes the desktop flyout.
  // AppShell has its own Escape handler for the mobile drawer; both firing is
  // intended — Escape means "get out of here".
  useEffect(() => {
    if (!openGroup) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenGroup(null); };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenGroup(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [openGroup]);

  const open = openGroup
    ? (NAV.find((e) => isGroup(e) && e.id === openGroup) as NavGroup | undefined)
    : undefined;

  return (
    <div ref={rootRef} data-nav-menu className="py-3 text-[12px] relative">
      <div className="px-4 pb-2 text-[10px] tracking-[0.3em] text-dim">NAV</div>

      {/* The list. Hidden on phones while a group is open (drill-down); always
          visible on desktop, where the panel floats alongside it. */}
      <div className={open ? 'max-md:hidden' : undefined}>
        {NAV.map((entry, i) => {
          // Decorative key hints, matching the terminal aesthetic of the flat
          // nav this replaced. Nothing binds them.
          const keyHint = String(i + 1);
          if (!isGroup(entry)) {
            return (
              <LeafRow key={entry.to} leaf={entry} keyHint={keyHint} onNavigate={onNavigate} />
            );
          }
          const isOpen = openGroup === entry.id;
          const lit = isOpen || activeGroup?.id === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-expanded={isOpen}
              aria-controls={`nav-panel-${entry.id}`}
              onClick={() => setOpenGroup(isOpen ? null : entry.id)}
              className={`navrow max-md:py-2.5 flex items-center gap-2 px-4 py-1.5 border-l-2 w-full text-left ${
                lit ? 'active border-hi' : 'border-transparent text-fg'
              }`}
            >
              <span className={lit ? 'text-hi' : 'text-dim'}>▸</span>
              <span className={lit ? 'text-hi' : ''}>{entry.label}</span>
              <span className="ml-auto text-dim text-[10px]">[{keyHint}]</span>
            </button>
          );
        })}
      </div>

      {open && (
        <div
          id={`nav-panel-${open.id}`}
          role="group"
          aria-label={open.label}
          className="md:absolute md:left-full md:top-0 md:z-50 md:w-[188px] md:-ml-px md:border md:border-hi/40 md:bg-panel md:shadow-[0_0_20px_rgba(0,0,0,0.7)] md:py-1"
        >
          {/* Phone: a back row returns to the list. Desktop: a plain heading —
              the list never went away, so there is nothing to go back to. */}
          {/* aria-label because the visible row reads "‹ back  PORTFOLIO",
              which would otherwise give this button the same accessible name
              as the group row that opened it — ambiguous for a screen reader. */}
          <button
            type="button"
            onClick={() => setOpenGroup(null)}
            aria-label="back to navigation"
            className="md:hidden navrow max-md:py-2.5 flex items-center gap-2 px-4 py-1.5 w-full text-left text-[11px]"
          >
            <span className="text-dim">‹</span>
            <span className="text-dim">back</span>
            <span className="ml-auto text-hi text-[10px] tracking-[0.25em] uppercase">
              {open.label}
            </span>
          </button>
          <div className="hidden md:block px-3 py-1 mb-1 text-[10px] tracking-[0.25em] text-hi border-b border-border">
            {open.label.toUpperCase()}
          </div>
          {open.children.map((leaf) => (
            <LeafRow key={leaf.to} leaf={leaf} onNavigate={onNavigate} nested />
          ))}
        </div>
      )}
    </div>
  );
}

function LeafRow({
  leaf,
  keyHint,
  onNavigate,
  nested = false,
}: {
  leaf: NavLeaf;
  keyHint?: string;
  onNavigate?: () => void;
  nested?: boolean;
}) {
  const location = useLocation();
  // NavLink's own isActive can't express '/trade/:id' belonging to '/trades',
  // so drive the highlight off the nav model's matcher instead.
  const isActive = matchesLeaf(location.pathname, leaf);
  return (
    <NavLink
      to={leaf.to}
      onClick={onNavigate}
      className={`navrow max-md:py-2.5 flex items-center gap-2 py-1.5 border-l-2 ${
        nested ? 'pl-7 pr-4 md:pl-3 md:pr-3' : 'px-4'
      } ${isActive ? 'active border-hi' : 'border-transparent text-fg'}`}
    >
      <span className={isActive ? 'text-hi' : 'text-dim'}>{isActive ? '▸' : '·'}</span>
      <span className={isActive ? 'text-hi' : ''}>{leaf.label}</span>
      {keyHint && <span className="ml-auto text-dim text-[10px]">[{keyHint}]</span>}
    </NavLink>
  );
}
