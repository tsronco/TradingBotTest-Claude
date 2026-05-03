interface ChainContract {
  strike_price: string;
  expiration_date: string;
  type: 'put' | 'call';
}

interface Snapshot {
  latestQuote?: { ap: number; bp: number };
  impliedVolatility?: number;
}

interface WheelInputs {
  stockPrice: number;
  buyingPower: number;
  contracts: ChainContract[];
  snapshots: Record<string, Snapshot>;
}

export type WheelabilityReason =
  | 'no_puts_in_range'      // chain has no puts in the 7-35 DTE window
  | 'no_quotes'             // puts in range exist but none have live bid/ask (markets closed?)
  | 'computed';             // we found a real best put and scored it

export interface WheelabilityResult {
  bestStrike: number | null;
  bestExpiration: string | null;
  yieldPct: number | null;
  spread: number | null;
  bpFit: boolean;
  annualizedPct: number | null;
  score: number;
  reason: WheelabilityReason;
}

export function scoreWheelability(input: WheelInputs): WheelabilityResult {
  const puts = input.contracts.filter((c) => c.type === 'put');
  let best: { strike: number; exp: string; bid: number; ask: number; iv: number; dte: number } | null = null;
  let putsInRange = 0;

  for (const c of puts) {
    const strike = Number(c.strike_price);
    const target = input.stockPrice * 0.9; // ~10% OTM
    const distFromTarget = Math.abs(strike - target);
    const dte = Math.max(1, Math.round((+new Date(c.expiration_date) - Date.now()) / 86400000));
    if (dte < 7 || dte > 35) continue;
    putsInRange++;
    const snap = input.snapshots[(c as any).symbol] ?? {};
    if (!snap.latestQuote) continue;

    const score =
      -distFromTarget * 10 +
      (snap.latestQuote.bp ?? 0) * 100 +
      Math.min(20, 30 - Math.abs(dte - 21));
    if (!best || score > (-Math.abs(best.strike - target) * 10 + best.bid * 100 + Math.min(20, 30 - Math.abs(best.dte - 21)))) {
      best = {
        strike,
        exp: c.expiration_date,
        bid: snap.latestQuote.bp,
        ask: snap.latestQuote.ap,
        iv: snap.impliedVolatility ?? 0,
        dte,
      };
    }
  }

  if (!best) {
    const reason: WheelabilityReason = putsInRange === 0 ? 'no_puts_in_range' : 'no_quotes';
    return { bestStrike: null, bestExpiration: null, yieldPct: null, spread: null, bpFit: false, annualizedPct: null, score: 0, reason };
  }

  const yieldPct = (best.bid / best.strike) * 100;
  const annualizedPct = yieldPct * (365 / best.dte);
  const spread = best.ask - best.bid;
  const bpFit = best.strike * 100 <= input.buyingPower;

  // Score: yield-weighted, spread-penalized, BP-gated.
  let s = 0;
  s += Math.min(40, yieldPct * 35);     // 1% yield → 35 pts (cap 40)
  s += spread < 0.10 ? 20 : spread < 0.25 ? 10 : 0;
  s += bpFit ? 20 : 0;
  s += Math.max(0, 20 - Math.abs(best.dte - 21));
  return {
    bestStrike: best.strike,
    bestExpiration: best.exp,
    yieldPct,
    spread,
    bpFit,
    annualizedPct,
    score: Math.min(100, Math.round(s)),
    reason: 'computed',
  };
}
