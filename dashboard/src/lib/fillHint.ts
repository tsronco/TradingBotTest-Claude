// dashboard/src/lib/fillHint.ts
export interface FillHintInput {
  side: 'buy' | 'sell';
  bid: number;
  ask: number;
  last?: number;
  oi?: number;
  volume?: number;
  tick?: number;
}
export interface FillHintTier { price: number; label: string; note: string }
export interface FillHint {
  bid: number; mid: number; ask: number;
  fast: FillHintTier; balanced: FillHintTier; patient: FillHintTier;
  confidence: string;
}

function rnd(x: number, tick: number): number {
  return Math.round(x / tick) * tick;
}

export function computeFillHint(input: FillHintInput): FillHint | null {
  const tick = input.tick && input.tick > 0 ? input.tick : 0.01;
  const { bid, ask, side } = input;
  if (!(bid > 0) || !(ask > 0) || bid >= ask) return null;
  const mid = rnd((bid + ask) / 2, tick);
  const step = Math.max(tick, rnd((ask - bid) / 4, tick));
  let fast: number;
  let patient: number;
  if (side === 'sell') {
    fast = rnd(bid, tick);
    patient = Math.min(rnd(mid + step, tick), rnd(ask - tick, tick));
  } else {
    fast = rnd(ask, tick);
    patient = Math.max(rnd(mid - step, tick), rnd(bid + tick, tick));
  }
  const r = (ask - bid) / mid;
  const liq = (input.oi ?? 0) >= 250 || (input.volume ?? 0) >= 250;
  const far = side === 'sell' ? 'bid' : 'ask';
  let confidence: string;
  if (r <= 0.03 && liq) confidence = 'Tight spread, liquid — mid usually fills.';
  else if (r <= 0.03) confidence = 'Tight spread but thin — mid likely, may need a tick.';
  else if (r > 0.08) confidence = `Wide spread — expect to concede toward the ${far}.`;
  else confidence = 'Moderate spread — mid is a reasonable start.';
  return {
    bid, mid, ask,
    fast: { price: fast, label: 'fast', note: side === 'sell' ? 'cross to bid — near-instant' : 'cross to ask — near-instant' },
    balanced: { price: mid, label: 'balanced', note: 'mid — fair, usually fills' },
    patient: { price: patient, label: 'best', note: side === 'sell' ? 'toward ask — best credit' : 'toward bid — best price' },
    confidence,
  };
}
