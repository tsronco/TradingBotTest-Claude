// Underlying stock prices for the Positions page, so an option or spread row
// can show "BAC $49.57" without a trip to /lookup (which also fires the AI
// summary). One batched /api/alpaca/quote?symbols=… call per account card.
import { parseOptionSymbol } from './option-symbol';

export interface UnderlyingQuote {
  last: number;
  changePct: number | null; // vs previous close, in percent
}

interface Snap {
  latestTrade?: { p?: number };
  dailyBar?: { c?: number };
  prevDailyBar?: { c?: number };
}

/** Sorted, de-duplicated underlyings of every option position. */
export function optionUnderlyings(positions: { symbol: string; asset_class: string }[]): string[] {
  const out = new Set<string>();
  for (const p of positions) {
    if (p.asset_class !== 'us_option') continue;
    const parsed = parseOptionSymbol(p.symbol);
    if (parsed) out.add(parsed.underlying);
  }
  return [...out].sort();
}

/** Alpaca's { SYM: snapshot } map → { SYM: { last, changePct } }; skips symbols with no price. */
export function parseUnderlyingQuotes(snapshot: unknown): Record<string, UnderlyingQuote> {
  const out: Record<string, UnderlyingQuote> = {};
  if (!snapshot || typeof snapshot !== 'object') return out;
  for (const [sym, raw] of Object.entries(snapshot as Record<string, Snap | null>)) {
    if (!raw) continue;
    const last = raw.latestTrade?.p ?? raw.dailyBar?.c;
    if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) continue;
    const prev = raw.prevDailyBar?.c;
    const changePct = typeof prev === 'number' && prev > 0 ? ((last - prev) / prev) * 100 : null;
    out[sym] = { last, changePct };
  }
  return out;
}
