// Pure sorting logic for the Trades table. Kept out of the component so the
// comparator rules stay unit-testable in isolation. Sorts trade+grade *pairs*
// together so the AI-grade column never desyncs from its row when reordered.

import type { Trade, GradeLetter } from './trade-types';
import { gradeIndex } from './trade-types';
import type { TradeGradeSummary } from '../hooks/useTrades';

export type SortKey =
  | 'date' | 'symbol' | 'side' | 'qty'
  | 'entry' | 'exit' | 'pnl' | 'grade' | 'ai' | 'tags';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export interface TradeRowPair {
  trade: Trade;
  grade: TradeGradeSummary;
}

/**
 * First-click direction for a column. Text columns read A→Z; date / numeric /
 * grade columns lead with the "interesting" end (newest, biggest, best grade)
 * so a single click surfaces what you usually want. A second click toggles.
 */
export function defaultDir(key: SortKey): SortDir {
  switch (key) {
    case 'symbol':
    case 'side':
    case 'tags':
      return 'asc';
    case 'grade':
    case 'ai':
      return 'asc'; // A+ (gradeIndex 0) first
    default:
      return 'desc'; // date / qty / entry / exit / pnl — newest or biggest first
  }
}

/** Comparable value for a column. null = "no value" and always sorts last. */
function sortValue(pair: TradeRowPair, key: SortKey): string | number | null {
  const t = pair.trade;
  switch (key) {
    case 'date':
      // ISO-8601 strings compare lexically === chronologically.
      return t.submitted_at || null;
    case 'symbol':
      return t.symbol || null;
    case 'side':
      return t.side || null;
    case 'qty':
      return t.qty ?? null;
    case 'entry':
      return t.filled_avg_price;
    case 'exit':
      return t.closed_avg_price;
    case 'pnl':
      return t.realized_pnl;
    case 'grade':
      return gradeIndex(t.entry_grade); // 0 (A+) … 10 (F)
    case 'ai': {
      const ai = pair.grade?.ai_letter;
      return ai ? gradeIndex(ai as GradeLetter) : null;
    }
    case 'tags':
      return t.tags && t.tags.length > 0 ? t.tags[0] : null;
  }
}

/**
 * Compare two column values. null/undefined always sorts LAST, in BOTH
 * directions — open trades with no exit or realized P&L stay at the bottom
 * whichever way you sort. Numbers compare numerically, everything else by
 * locale string compare.
 */
function compareValues(a: string | number | null, b: string | number | null, dir: SortDir): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;  // a sorts after b
  if (bNull) return -1; // b sorts after a

  let r: number;
  if (typeof a === 'number' && typeof b === 'number') {
    r = a - b;
  } else {
    r = String(a).localeCompare(String(b));
  }
  return dir === 'asc' ? r : -r;
}

/**
 * Return a NEW array of pairs sorted by the given column/direction. A `null`
 * sort returns the input order unchanged (the server's order). The sort is
 * stable, so rows with equal keys keep their original relative order.
 */
export function sortTradePairs(pairs: TradeRowPair[], sort: SortState | null): TradeRowPair[] {
  if (!sort) return pairs;
  return [...pairs].sort((p1, p2) =>
    compareValues(sortValue(p1, sort.key), sortValue(p2, sort.key), sort.dir),
  );
}
