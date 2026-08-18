// The sidebar navigation model.
//
// Kept as data (and pure matchers) separate from the rendering so the route →
// active-item logic is unit-testable without mounting a router, and so adding
// a page is a one-line change in one place.
//
// Grouped by what you're doing rather than by page type: the flat ten-row list
// this replaced had outgrown a phone screen, and a flat list of ten gives no
// hint about which pages belong together.

export interface NavLeaf {
  /** Link target. */
  to: string;
  label: string;
  /**
   * Path prefixes that count as "you are on this page", used for the active
   * highlight. A prefix matches the path itself or any child segment, so
   * '/rules' covers '/rules/edit'. Detail routes that don't share the list
   * route's prefix need an explicit entry — '/trade/:id' does NOT start with
   * '/trades', and '/order/new' does NOT start with '/orders'.
   */
  match: string[];
}

export interface NavGroup {
  id: string;
  label: string;
  children: NavLeaf[];
}

export type NavEntry = NavLeaf | NavGroup;

export function isGroup(entry: NavEntry): entry is NavGroup {
  return (entry as NavGroup).children !== undefined;
}

export const NAV: NavEntry[] = [
  { to: '/', label: 'home', match: ['/'] },
  {
    id: 'portfolio',
    label: 'portfolio',
    children: [
      { to: '/positions', label: 'positions', match: ['/positions'] },
      // '/order/new' is the order form — same job as the orders list.
      { to: '/orders', label: 'orders', match: ['/orders', '/order'] },
      // '/trade/:id' is a single trade's detail page (singular, no 's').
      { to: '/trades', label: 'trades', match: ['/trades', '/trade'] },
    ],
  },
  {
    id: 'research',
    label: 'research',
    children: [
      // Lookup needs a symbol in the URL; SPY is the neutral default the flat
      // nav used too. '/strategy/:symbol' is reached from a lookup page.
      { to: '/lookup/SPY', label: 'lookup', match: ['/lookup', '/strategy'] },
      { to: '/watchlist', label: 'watchlist', match: ['/watchlist'] },
      { to: '/calendar', label: 'calendar', match: ['/calendar'] },
    ],
  },
  {
    id: 'insights',
    label: 'insights',
    children: [
      { to: '/performance', label: 'performance', match: ['/performance'] },
      { to: '/rules', label: 'rules', match: ['/rules'] },
    ],
  },
  { to: '/agent', label: 'agent', match: ['/agent'] },
];

/** Does `pathname` fall under this leaf? */
export function matchesLeaf(pathname: string, leaf: NavLeaf): boolean {
  return leaf.match.some((prefix) => {
    // Home is the only exact match — every path starts with '/', so treating
    // it as a prefix would light up home on every page.
    if (prefix === '/') return pathname === '/';
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

/** The group whose children contain `pathname`, or null for a top-level page. */
export function groupContaining(pathname: string): NavGroup | null {
  for (const entry of NAV) {
    if (isGroup(entry) && entry.children.some((c) => matchesLeaf(pathname, c))) {
      return entry;
    }
  }
  return null;
}

/** The top-level leaf matching `pathname`, or null when inside a group. */
export function topLevelLeafFor(pathname: string): NavLeaf | null {
  for (const entry of NAV) {
    if (!isGroup(entry) && matchesLeaf(pathname, entry)) return entry;
  }
  return null;
}

/** Label of the current page, for the flyout/back-row heading. */
export function activeLeaf(pathname: string): NavLeaf | null {
  for (const entry of NAV) {
    if (isGroup(entry)) {
      const hit = entry.children.find((c) => matchesLeaf(pathname, c));
      if (hit) return hit;
    } else if (matchesLeaf(pathname, entry)) {
      return entry;
    }
  }
  return null;
}
