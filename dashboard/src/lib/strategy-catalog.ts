// dashboard/src/lib/strategy-catalog.ts
//
// Hand-curated catalog of options strategies surfaced on the
// `/strategy/:symbol` Strategy Builder page. Each strategy carries:
//   - id           — stable string used in URLs / tests
//   - section      — display grouping
//   - direction    — Bullish | Bearish | Neutral | Volatile
//   - status       — 'wired' (clickable, opens a form) or 'coming_soon'
//   - intent       — what to navigate to when the card is clicked. See navigateForIntent.
//   - sampleLegs   — leg shape used by PayoffSparkline to draw the canonical curve.
//                    Scales to the given spot so each card draws naturally regardless
//                    of which symbol the user is on.
//
// The 4 vertical-spread cards point at the existing /order/new?spread=...
// form (now generalized for all 4 types). Single-leg cards point at the
// /strategy/:symbol/pick subroute, which embeds an OptionsChain locked to
// the right leg type + force-routes the bid/ask click to the correct
// open side (BTO vs STO).
//
// Coming-soon cards have intent='coming_soon' and render as visibly-but-
// not-clickably greyed out. They are wired to the picker but the strategy
// builder UI gates onClick.

import type { Leg } from './payoff';

export type StrategySection =
  | 'Single Leg'
  | 'Vertical Spreads'
  | 'Straddles and Strangles'
  | 'Calendar Spreads';

export type StrategyDirection = 'Bullish' | 'Bearish' | 'Neutral' | 'Volatile';

export type StrategyStatus = 'wired' | 'coming_soon';

export type StrategyIntent =
  /** Pick a single contract from the chain, then open OptionOrderForm. */
  | { kind: 'pick_contract'; leg: 'call' | 'put'; side: 'BTO' | 'STO' }
  /** Open the vertical-spread form pre-configured for this spread_type. */
  | { kind: 'spread'; spread_type: 'put_credit' | 'put_debit' | 'call_credit' | 'call_debit' }
  /** Not yet wired up. Card renders but click is a no-op. */
  | { kind: 'coming_soon' };

export interface StrategyDef {
  id: string;
  name: string;
  section: StrategySection;
  direction: StrategyDirection;
  /** One-line description (≤120 chars), shown under the card title. */
  blurb: string;
  status: StrategyStatus;
  intent: StrategyIntent;
  /**
   * Build the legs used to draw the card's payoff sparkline. `spot` is the
   * underlying price at the time the card renders; this lets each card
   * pick natural strikes (e.g. +5% / −5% relative to spot) without
   * hardcoding a $100 placeholder.
   */
  sampleLegs(spot: number): Leg[];
}

// Helper — synthesize a per-share premium for a struck contract. The
// sparkline shape doesn't depend on the absolute magnitude as long as the
// premium is roughly in the right ballpark vs strike (so the chart can
// draw a recognizable hockey-stick). The premium = 2% of spot works well
// across all cards.
function approxPremium(spot: number): number {
  return Math.max(spot * 0.02, 0.05);
}

export const STRATEGY_CATALOG: StrategyDef[] = [
  // --- Single Leg ---
  {
    id: 'long_call',
    name: 'Long Call',
    section: 'Single Leg',
    direction: 'Bullish',
    blurb: 'Buy a call. Profits when the stock goes up.',
    status: 'wired',
    intent: { kind: 'pick_contract', leg: 'call', side: 'BTO' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'long', type: 'call', strike: round5(spot), premium: approxPremium(spot), contracts: 1 },
    ],
  },
  {
    id: 'covered_call',
    name: 'Covered Call',
    section: 'Single Leg',
    direction: 'Bullish',
    blurb: 'Sell a call against 100 shares you own. Caps upside, collects premium.',
    status: 'wired',
    intent: { kind: 'pick_contract', leg: 'call', side: 'STO' },
    sampleLegs: (spot) => [
      { kind: 'stock', dir: 'long', entry: spot, shares: 100 },
      { kind: 'option', dir: 'short', type: 'call', strike: round5(spot * 1.05), premium: approxPremium(spot), contracts: 1 },
    ],
  },
  {
    id: 'long_put',
    name: 'Long Put',
    section: 'Single Leg',
    direction: 'Bearish',
    blurb: 'Buy a put. Profits when the stock goes down.',
    status: 'wired',
    intent: { kind: 'pick_contract', leg: 'put', side: 'BTO' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'long', type: 'put', strike: round5(spot), premium: approxPremium(spot), contracts: 1 },
    ],
  },
  {
    id: 'cash_secured_put',
    name: 'Cash-Secured Put',
    section: 'Single Leg',
    direction: 'Bullish',
    blurb: 'Sell a put backed by cash. Collect premium; willing to be assigned shares.',
    status: 'wired',
    intent: { kind: 'pick_contract', leg: 'put', side: 'STO' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'short', type: 'put', strike: round5(spot * 0.95), premium: approxPremium(spot), contracts: 1 },
    ],
  },

  // --- Vertical Spreads ---
  {
    id: 'call_debit_spread',
    name: 'Call Debit Spread',
    section: 'Vertical Spreads',
    direction: 'Bullish',
    blurb: 'Buy a lower-strike call, sell a higher-strike call. Capped bullish bet.',
    status: 'wired',
    intent: { kind: 'spread', spread_type: 'call_debit' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'long',  type: 'call', strike: round5(spot * 0.97), premium: approxPremium(spot) * 1.3, contracts: 1 },
      { kind: 'option', dir: 'short', type: 'call', strike: round5(spot * 1.04), premium: approxPremium(spot) * 0.7, contracts: 1 },
    ],
  },
  {
    id: 'call_credit_spread',
    name: 'Call Credit Spread',
    section: 'Vertical Spreads',
    direction: 'Bearish',
    blurb: 'Sell a lower-strike call, buy a higher-strike call. Collect credit, capped risk.',
    status: 'wired',
    intent: { kind: 'spread', spread_type: 'call_credit' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'short', type: 'call', strike: round5(spot * 1.03), premium: approxPremium(spot) * 0.9, contracts: 1 },
      { kind: 'option', dir: 'long',  type: 'call', strike: round5(spot * 1.10), premium: approxPremium(spot) * 0.5, contracts: 1 },
    ],
  },
  {
    id: 'put_debit_spread',
    name: 'Put Debit Spread',
    section: 'Vertical Spreads',
    direction: 'Bearish',
    blurb: 'Buy a higher-strike put, sell a lower-strike put. Capped bearish bet.',
    status: 'wired',
    intent: { kind: 'spread', spread_type: 'put_debit' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'long',  type: 'put', strike: round5(spot * 1.03), premium: approxPremium(spot) * 1.3, contracts: 1 },
      { kind: 'option', dir: 'short', type: 'put', strike: round5(spot * 0.96), premium: approxPremium(spot) * 0.7, contracts: 1 },
    ],
  },
  {
    id: 'put_credit_spread',
    name: 'Put Credit Spread',
    section: 'Vertical Spreads',
    direction: 'Bullish',
    blurb: 'Sell a higher-strike put, buy a lower-strike put. Collect credit, capped risk.',
    status: 'wired',
    intent: { kind: 'spread', spread_type: 'put_credit' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'short', type: 'put', strike: round5(spot * 0.97), premium: approxPremium(spot) * 0.9, contracts: 1 },
      { kind: 'option', dir: 'long',  type: 'put', strike: round5(spot * 0.90), premium: approxPremium(spot) * 0.5, contracts: 1 },
    ],
  },

  // --- Straddles and Strangles --- (coming soon)
  {
    id: 'long_straddle',
    name: 'Long Straddle',
    section: 'Straddles and Strangles',
    direction: 'Volatile',
    blurb: 'Buy ATM call + ATM put. Profits from a big move either way.',
    status: 'coming_soon',
    intent: { kind: 'coming_soon' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'long', type: 'call', strike: round5(spot), premium: approxPremium(spot), contracts: 1 },
      { kind: 'option', dir: 'long', type: 'put',  strike: round5(spot), premium: approxPremium(spot), contracts: 1 },
    ],
  },
  {
    id: 'long_strangle',
    name: 'Long Strangle',
    section: 'Straddles and Strangles',
    direction: 'Volatile',
    blurb: 'Buy OTM call + OTM put. Cheaper than a straddle, needs a bigger move.',
    status: 'coming_soon',
    intent: { kind: 'coming_soon' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'long', type: 'call', strike: round5(spot * 1.05), premium: approxPremium(spot) * 0.7, contracts: 1 },
      { kind: 'option', dir: 'long', type: 'put',  strike: round5(spot * 0.95), premium: approxPremium(spot) * 0.7, contracts: 1 },
    ],
  },

  // --- Calendar Spreads --- (coming soon)
  // Calendar P&L curves require a vol model (front/back IV); using a
  // simple expiry-payoff approximation here is misleading. The cards
  // render a tent-shape placeholder via a long-straddle-ish stand-in.
  {
    id: 'long_call_calendar_spread',
    name: 'Long Call Calendar Spread',
    section: 'Calendar Spreads',
    direction: 'Neutral',
    blurb: 'Sell near-expiry call, buy far-expiry call at the same strike. Bets on stable price.',
    status: 'coming_soon',
    intent: { kind: 'coming_soon' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'short', type: 'call', strike: round5(spot), premium: approxPremium(spot) * 0.6, contracts: 1 },
      { kind: 'option', dir: 'long',  type: 'call', strike: round5(spot), premium: approxPremium(spot) * 1.2, contracts: 1 },
    ],
  },
  {
    id: 'long_put_calendar_spread',
    name: 'Long Put Calendar Spread',
    section: 'Calendar Spreads',
    direction: 'Neutral',
    blurb: 'Sell near-expiry put, buy far-expiry put at the same strike. Bets on stable price.',
    status: 'coming_soon',
    intent: { kind: 'coming_soon' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'short', type: 'put', strike: round5(spot), premium: approxPremium(spot) * 0.6, contracts: 1 },
      { kind: 'option', dir: 'long',  type: 'put', strike: round5(spot), premium: approxPremium(spot) * 1.2, contracts: 1 },
    ],
  },
  {
    id: 'short_put_calendar_spread',
    name: 'Short Put Calendar Spread',
    section: 'Calendar Spreads',
    direction: 'Volatile',
    blurb: 'Buy near-expiry put, sell far-expiry put. Bets on a near-term move.',
    status: 'coming_soon',
    intent: { kind: 'coming_soon' },
    sampleLegs: (spot) => [
      { kind: 'option', dir: 'long',  type: 'put', strike: round5(spot), premium: approxPremium(spot) * 0.6, contracts: 1 },
      { kind: 'option', dir: 'short', type: 'put', strike: round5(spot), premium: approxPremium(spot) * 1.2, contracts: 1 },
    ],
  },
];

export const STRATEGY_SECTIONS: StrategySection[] = [
  'Single Leg',
  'Vertical Spreads',
  'Straddles and Strangles',
  'Calendar Spreads',
];

export const SECTION_BLURBS: Record<StrategySection, string> = {
  'Single Leg': 'The fundamental options strategies. Buy or sell calls and puts.',
  'Vertical Spreads': 'Simultaneously buy and sell similar options using different strike prices. Designed to profit from gains or losses in the price of an underlying asset.',
  'Straddles and Strangles': 'Two-legged strategies designed to profit from volatility.',
  'Calendar Spreads': 'Simultaneously buy and sell similar options using different expiration dates. Designed to profit from differences in implied volatility over time.',
};

export function getStrategyById(id: string): StrategyDef | undefined {
  return STRATEGY_CATALOG.find((s) => s.id === id);
}

/**
 * Build the route to navigate to when a strategy card is clicked.
 * Returns null if the strategy is coming_soon (caller should no-op).
 */
export function navigateForIntent(intent: StrategyIntent, symbol: string): string | null {
  if (intent.kind === 'coming_soon') return null;
  if (intent.kind === 'spread') {
    return `/order/new?spread=${intent.spread_type}&symbol=${symbol}`;
  }
  // pick_contract — single-leg chooser
  return `/strategy/${symbol}/pick?leg=${intent.leg}&side=${intent.side}`;
}

// Round to nearest $5 (or $1 for cheap underlyings) so the sample strikes
// look reasonable on the card payoff sparkline.
function round5(x: number): number {
  if (x < 20) return Math.max(1, Math.round(x));
  return Math.round(x / 5) * 5;
}
