interface ChainContract {
  strike_price: string;
  expiration_date: string;
  type: 'put' | 'call';
}

interface Snapshot {
  latestQuote?: { ap: number; bp: number };
  impliedVolatility?: number;
}

// Both surviving accounts (manual + live) use the same ~10% OTM wheel band
// for managing existing positions (50% close, 14-28 DTE puts).
export type WheelMode = 'manual' | 'live';

interface WheelInputs {
  stockPrice: number;
  // Use Alpaca's options_buying_power, not buying_power. Cash-secured puts
  // can only draw from options BP — the regular margin BP includes leverage
  // that doesn't apply to short option collateral, so it overstates capacity.
  optionsBuyingPower: number;
  contracts: ChainContract[];
  snapshots: Record<string, Snapshot>;
  // Wheel mode controls the target OTM band — both manual and live aim ~10%
  // OTM (matches the bot config in /config.py MODES).
  mode?: WheelMode;
}

// Per-mode target band: bot only sells puts within this OTM range, so the
// wheelability "best" recommendation should match. ±3 percentage points around
// the target (manual/live: 7-13% OTM).
const TARGET_OTM_PCT = { manual: 0.10, live: 0.10 } as const;
const BAND_HALF_WIDTH_PCT = 0.03;

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
  // Filter to puts that fall in the wheel's actual operating band — anything
  // outside this range isn't a candidate the bot would ever sell, so it's not
  // a useful "best" recommendation either. The bot only sells:
  //   manual/live: ~10% OTM puts (we accept 7-13% OTM)
  const target = TARGET_OTM_PCT[input.mode ?? 'manual'];
  const lowStrike = input.stockPrice * (1 - target - BAND_HALF_WIDTH_PCT);
  const highStrike = input.stockPrice * (1 - target + BAND_HALF_WIDTH_PCT);
  const targetStrike = input.stockPrice * (1 - target);
  const puts = input.contracts.filter((c) => {
    if (c.type !== 'put') return false;
    const strike = Number(c.strike_price);
    return strike >= lowStrike && strike <= highStrike;
  });
  let best: { strike: number; exp: string; bid: number; ask: number; iv: number; dte: number; score: number } | null = null;
  let putsInRange = 0;

  for (const c of puts) {
    const strike = Number(c.strike_price);
    const distFromTarget = Math.abs(strike - targetStrike);
    const dte = Math.max(1, Math.round((+new Date(c.expiration_date) - Date.now()) / 86400000));
    if (dte < 7 || dte > 35) continue;
    putsInRange++;
    const snap = input.snapshots[(c as any).symbol] ?? {};
    if (!snap.latestQuote) continue;

    // Within the band, yield is the dominant factor; distance and DTE are
    // tiebreakers between strikes that are all wheel-eligible to begin with.
    const yieldPct = (snap.latestQuote.bp / strike) * 100;
    const score =
      yieldPct * 30 +              // 1% yield → 30 pts
      -distFromTarget * 1 +        // small nudge toward exact target strike
      Math.min(20, 30 - Math.abs(dte - 21)); // sweet spot near 21 DTE
    if (!best || score > best.score) {
      best = {
        strike,
        exp: c.expiration_date,
        bid: snap.latestQuote.bp,
        ask: snap.latestQuote.ap,
        iv: snap.impliedVolatility ?? 0,
        dte,
        score,
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
  const bpFit = best.strike * 100 <= input.optionsBuyingPower;

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
