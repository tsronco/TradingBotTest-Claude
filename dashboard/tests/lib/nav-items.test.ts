/**
 * The sidebar nav model. The interesting part is route matching: several detail
 * routes do NOT share their list route's prefix, so a naive startsWith would
 * silently leave the sidebar unhighlighted on those pages.
 */
import { describe, it, expect } from 'vitest';
import {
  NAV,
  isGroup,
  matchesLeaf,
  groupContaining,
  topLevelLeafFor,
  activeLeaf,
  type NavLeaf,
} from '../../src/lib/nav-items';

function leaf(label: string): NavLeaf {
  for (const e of NAV) {
    if (isGroup(e)) {
      const hit = e.children.find((c) => c.label === label);
      if (hit) return hit;
    } else if (e.label === label) return e;
  }
  throw new Error(`no nav leaf labelled ${label}`);
}

describe('nav model shape', () => {
  it('keeps home and agent top-level and groups the rest', () => {
    const top = NAV.filter((e) => !isGroup(e)).map((e) => (e as NavLeaf).label);
    expect(top).toEqual(['home', 'agent']);
    const groups = NAV.filter(isGroup).map((g) => g.id);
    expect(groups).toEqual(['portfolio', 'research', 'insights']);
  });

  it('still exposes every page the flat nav had', () => {
    const all = NAV.flatMap((e) => (isGroup(e) ? e.children : [e])).map((l) => l.label).sort();
    expect(all).toEqual([
      'agent', 'calendar', 'home', 'lookup', 'orders',
      'performance', 'positions', 'rules', 'trades', 'watchlist',
    ]);
  });

  it('collapses to 5 top-level rows (was 10)', () => {
    expect(NAV).toHaveLength(5);
  });

  it('has unique group ids and unique link targets', () => {
    const ids = NAV.filter(isGroup).map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tos = NAV.flatMap((e) => (isGroup(e) ? e.children : [e])).map((l) => l.to);
    expect(new Set(tos).size).toBe(tos.length);
  });
});

describe('matchesLeaf', () => {
  it('matches the page itself', () => {
    expect(matchesLeaf('/positions', leaf('positions'))).toBe(true);
  });

  it('treats home as exact — not a prefix of everything', () => {
    expect(matchesLeaf('/', leaf('home'))).toBe(true);
    expect(matchesLeaf('/positions', leaf('home'))).toBe(false);
    expect(matchesLeaf('/agent', leaf('home'))).toBe(false);
  });

  it('matches child segments', () => {
    expect(matchesLeaf('/rules/edit', leaf('rules'))).toBe(true);
    expect(matchesLeaf('/lookup/SPY', leaf('lookup'))).toBe(true);
  });

  it('matches detail routes that do NOT share the list prefix', () => {
    // '/trade/T-2026-08-18-001' does not start with '/trades'.
    expect(matchesLeaf('/trade/T-2026-08-18-001', leaf('trades'))).toBe(true);
    // '/order/new' does not start with '/orders'.
    expect(matchesLeaf('/order/new', leaf('orders'))).toBe(true);
    // '/strategy/AAPL' is reached from lookup.
    expect(matchesLeaf('/strategy/AAPL', leaf('lookup'))).toBe(true);
  });

  it('does not let a shared word-prefix bleed across pages', () => {
    // '/order' is a string prefix of '/orders' — the segment-aware check must
    // not make the trades row light up on the orders page, or vice versa.
    expect(matchesLeaf('/orders', leaf('trades'))).toBe(false);
    expect(matchesLeaf('/trades', leaf('orders'))).toBe(false);
    expect(matchesLeaf('/performance', leaf('positions'))).toBe(false);
  });

  it('does not match an unrelated path', () => {
    expect(matchesLeaf('/settings', leaf('positions'))).toBe(false);
    expect(matchesLeaf('/changelog', leaf('calendar'))).toBe(false);
  });
});

describe('groupContaining', () => {
  it('finds the group for a nested page', () => {
    expect(groupContaining('/positions')?.id).toBe('portfolio');
    expect(groupContaining('/watchlist')?.id).toBe('research');
    expect(groupContaining('/rules/edit')?.id).toBe('insights');
  });

  it('finds the group from a detail route', () => {
    expect(groupContaining('/trade/T-1')?.id).toBe('portfolio');
    expect(groupContaining('/lookup/TSLA')?.id).toBe('research');
  });

  it('returns null for top-level pages and unknown routes', () => {
    expect(groupContaining('/')).toBeNull();
    expect(groupContaining('/agent')).toBeNull();
    expect(groupContaining('/settings')).toBeNull();
  });
});

describe('topLevelLeafFor / activeLeaf', () => {
  it('resolves top-level pages', () => {
    expect(topLevelLeafFor('/')?.label).toBe('home');
    expect(topLevelLeafFor('/agent')?.label).toBe('agent');
    expect(topLevelLeafFor('/positions')).toBeNull();
  });

  it('resolves the active leaf anywhere in the tree', () => {
    expect(activeLeaf('/')?.label).toBe('home');
    expect(activeLeaf('/orders')?.label).toBe('orders');
    expect(activeLeaf('/order/new')?.label).toBe('orders');
    expect(activeLeaf('/agent')?.label).toBe('agent');
    expect(activeLeaf('/settings')).toBeNull();
  });
});
