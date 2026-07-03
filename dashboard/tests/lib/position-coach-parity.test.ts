import { describe, expect, it } from 'vitest';
import { buildPositionFacts, deterministicReadout as serverReadout, type RawPosition, type RawStrategySym } from '../../api/_lib/position-coach';
import { deterministicReadout as clientReadout } from '../../src/components/lookup/PositionCoachPanel';

// The client re-implements deterministicReadout as an LLM-down fallback. It must
// produce a byte-identical string to the server's, or the panel would show
// different text depending on whether the model was up. This asserts parity
// across the trailing-stop branches (off / on-gain / on-loss / triggering / none).
const P = (over: Partial<RawPosition> = {}): RawPosition => ({ symbol: 'SNAP', qty: '5', avg_entry_price: '4.53', current_price: '4.42', asset_class: 'us_equity', side: 'long', ...over });

const CASES: Array<{ name: string; pos: RawPosition; strat: RawStrategySym | null }> = [
  { name: 'off',        pos: P(),                         strat: { stop_price: 4.08, high_water_mark: 4.53, trailing_active: false, entry_price: 4.53, ladder_done: [false, false, false], initial_qty: 5 } },
  { name: 'on-gain',    pos: P({ current_price: '5.00' }), strat: { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 } },
  { name: 'on-loss',    pos: P({ current_price: '4.60' }), strat: { stop_price: 4.40, high_water_mark: 4.75, trailing_active: true, entry_price: 4.53 } },
  { name: 'triggering', pos: P({ current_price: '4.90' }), strat: { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 } },
  { name: 'no-state',   pos: P(),                         strat: null },
  { name: 'one-share',  pos: P({ qty: '1', current_price: '5.00' }), strat: { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 } },
];

describe('client/server deterministicReadout parity', () => {
  it.each(CASES)('matches for $name', ({ pos, strat }) => {
    const facts = buildPositionFacts('SNAP', 'live', pos, strat, null, []);
    expect(clientReadout(facts)).toBe(serverReadout(facts));
  });
});
