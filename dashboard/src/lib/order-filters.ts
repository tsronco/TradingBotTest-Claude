export type DateRangeKey = 'day' | 'week' | 'month-rolling' | 'month' | 'year' | 'all';

export const DATE_RANGE_OPTIONS: { key: DateRangeKey; label: string }[] = [
  { key: 'day', label: 'today' },
  { key: 'week', label: '7d' },
  { key: 'month-rolling', label: '30d' },
  { key: 'month', label: 'month' },
  { key: 'year', label: 'ytd' },
  { key: 'all', label: 'all' },
];

/**
 * Returns the ISO timestamp to pass as Alpaca's `after` filter, or null for "no filter".
 * Anchored to local time so "today" / "this month" / "this year" line up with the user's calendar.
 */
export function dateRangeToAfter(range: DateRangeKey, now: Date = new Date()): string | null {
  if (range === 'all') return null;
  if (range === 'day') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  if (range === 'week') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (range === 'month-rolling') {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (range === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();
  }
  if (range === 'year') {
    return new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0).toISOString();
  }
  return null;
}

/**
 * Extract the underlying ticker from any Alpaca order symbol.
 * - Stocks: `AAPL` → `AAPL`
 * - Options (OCC): `AMD260116P00120000` → `AMD`
 */
export function underlyingFromSymbol(symbol: string): string {
  // OCC option symbols are 1-6 alpha + 6 digits + C/P + 8 digits.
  const m = symbol.match(/^([A-Z]{1,6})\d{6}[CP]\d{8}$/);
  return m ? m[1] : symbol;
}

/**
 * Sorted unique list of underlying tickers across the supplied symbol streams.
 * Empty streams (e.g., a card that hasn't loaded yet) are tolerated.
 */
export function collectUnderlyings(...symbolStreams: (string[] | undefined)[]): string[] {
  const set = new Set<string>();
  for (const stream of symbolStreams) {
    if (!stream) continue;
    for (const sym of stream) set.add(underlyingFromSymbol(sym));
  }
  return Array.from(set).sort();
}
