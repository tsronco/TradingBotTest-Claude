import { describe, it, expect } from 'vitest';
import {
  STRATEGY_CATALOG,
  STRATEGY_SECTIONS,
  SECTION_BLURBS,
  getStrategyById,
  navigateForIntent,
} from '../../src/lib/strategy-catalog';
import { buildPayoff } from '../../src/lib/payoff';

describe('strategy-catalog', () => {
  it('exports exactly 13 strategies (Robinhood parity)', () => {
    expect(STRATEGY_CATALOG.length).toBe(13);
  });

  it('every strategy has a unique id', () => {
    const ids = STRATEGY_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every section in STRATEGY_SECTIONS has a blurb', () => {
    for (const section of STRATEGY_SECTIONS) {
      expect(SECTION_BLURBS[section]).toBeTruthy();
    }
  });

  it('every strategy belongs to a known section', () => {
    for (const s of STRATEGY_CATALOG) {
      expect(STRATEGY_SECTIONS).toContain(s.section);
    }
  });

  it('navigateForIntent returns null for coming_soon strategies', () => {
    const straddle = getStrategyById('long_straddle');
    expect(straddle?.status).toBe('coming_soon');
    expect(navigateForIntent(straddle!.intent, 'SPY')).toBeNull();
  });

  it('navigateForIntent routes vertical spreads to /order/new with the right spread_type', () => {
    for (const id of ['put_credit_spread', 'put_debit_spread', 'call_credit_spread', 'call_debit_spread']) {
      const s = getStrategyById(id);
      expect(s).toBeDefined();
      const url = navigateForIntent(s!.intent, 'AAL');
      expect(url).not.toBeNull();
      expect(url).toMatch(/^\/order\/new\?spread=(put_credit|put_debit|call_credit|call_debit)&symbol=AAL$/);
    }
  });

  it('navigateForIntent routes single-leg strategies to /strategy/:symbol/pick with leg+side', () => {
    expect(navigateForIntent(getStrategyById('long_call')!.intent, 'NVDA'))
      .toBe('/strategy/NVDA/pick?leg=call&side=BTO');
    expect(navigateForIntent(getStrategyById('long_put')!.intent, 'NVDA'))
      .toBe('/strategy/NVDA/pick?leg=put&side=BTO');
    expect(navigateForIntent(getStrategyById('covered_call')!.intent, 'NVDA'))
      .toBe('/strategy/NVDA/pick?leg=call&side=STO');
    expect(navigateForIntent(getStrategyById('cash_secured_put')!.intent, 'NVDA'))
      .toBe('/strategy/NVDA/pick?leg=put&side=STO');
  });

  it('exposes exactly 4 wired vertical spreads + 4 wired single legs', () => {
    const wired = STRATEGY_CATALOG.filter((s) => s.status === 'wired');
    expect(wired.length).toBe(8);
    const verticals = wired.filter((s) => s.section === 'Vertical Spreads');
    expect(verticals.length).toBe(4);
    const singles = wired.filter((s) => s.section === 'Single Leg');
    expect(singles.length).toBe(4);
  });

  it('coming_soon strategies cover straddles, strangles, and calendars', () => {
    const soon = STRATEGY_CATALOG.filter((s) => s.status === 'coming_soon');
    expect(soon.length).toBe(5);
    const ids = soon.map((s) => s.id).sort();
    expect(ids).toEqual([
      'long_call_calendar_spread',
      'long_put_calendar_spread',
      'long_straddle',
      'long_strangle',
      'short_put_calendar_spread',
    ]);
  });

  describe('sampleLegs payoff shapes', () => {
    const SPOT = 100;

    it('Long Call max loss is capped at the premium paid', () => {
      const s = getStrategyById('long_call')!;
      const r = buildPayoff(s.sampleLegs(SPOT), SPOT);
      expect(r.maxLoss).toBeLessThan(0);
      expect(r.maxLoss).toBeGreaterThan(-500); // bounded by premium × 100
      expect(r.maxProfit).toBeNull(); // unbounded upside
    });

    it('Long Put max profit is bounded by strike × 100', () => {
      const s = getStrategyById('long_put')!;
      const r = buildPayoff(s.sampleLegs(SPOT), SPOT);
      expect(r.maxLoss).toBeLessThan(0);
      expect(r.maxProfit).not.toBeNull();
      expect(r.maxProfit!).toBeGreaterThan(0);
    });

    it('Cash-Secured Put has bounded loss (assignment), bounded profit (premium)', () => {
      const s = getStrategyById('cash_secured_put')!;
      const r = buildPayoff(s.sampleLegs(SPOT), SPOT);
      expect(r.maxLoss).not.toBeNull();
      expect(r.maxProfit).not.toBeNull();
      expect(r.maxProfit!).toBeGreaterThan(0);
    });

    it('Put Credit Spread has bounded max profit and bounded max loss', () => {
      const s = getStrategyById('put_credit_spread')!;
      const r = buildPayoff(s.sampleLegs(SPOT), SPOT);
      expect(r.maxProfit).not.toBeNull();
      expect(r.maxLoss).not.toBeNull();
      expect(r.maxProfit!).toBeGreaterThan(0);
      expect(r.maxLoss!).toBeLessThan(0);
    });

    it('Call Debit Spread has bounded max profit and bounded max loss', () => {
      const s = getStrategyById('call_debit_spread')!;
      const r = buildPayoff(s.sampleLegs(SPOT), SPOT);
      expect(r.maxProfit).not.toBeNull();
      expect(r.maxLoss).not.toBeNull();
      expect(r.maxProfit!).toBeGreaterThan(0);
      expect(r.maxLoss!).toBeLessThan(0);
    });

    it('Long Straddle has bounded loss (sum of premiums) and unbounded upside', () => {
      const s = getStrategyById('long_straddle')!;
      const r = buildPayoff(s.sampleLegs(SPOT), SPOT);
      expect(r.maxLoss).not.toBeNull();
      expect(r.maxLoss!).toBeLessThan(0);
      expect(r.maxProfit).toBeNull();
    });
  });
});
