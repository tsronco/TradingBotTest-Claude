import { describe, it, expect } from 'vitest';
import {
  actionableIdeas,
  briefDateLabel,
  briefIsStale,
  briefTimeLabel,
  easternDateKey,
  type LiveBriefRecord,
} from '../../src/lib/live-brief';

function brief(over: Partial<LiveBriefRecord> = {}): LiveBriefRecord {
  return {
    date: '2026-09-10',
    generated_at: '2026-09-10T13:40:12Z',
    model: 'claude-opus-5',
    account: { equity: 150.72, cash: 44.61, options_buying_power: 0 },
    market_read: 'quiet open',
    ideas: [],
    held: [],
    no_trade_reason: '',
    refused: false,
    ...over,
  };
}

describe('live-brief helpers', () => {
  it('easternDateKey renders the ET calendar date, not UTC', () => {
    // 01:30 UTC on Sep 11 is still 21:30 ET on Sep 10.
    expect(easternDateKey(new Date('2026-09-11T01:30:00Z'))).toBe('2026-09-10');
    expect(easternDateKey(new Date('2026-09-10T13:40:00Z'))).toBe('2026-09-10');
  });

  it('briefIsStale is false for today (ET) and true for any other day or no brief', () => {
    const now = new Date('2026-09-10T15:00:00Z');
    expect(briefIsStale(brief(), now)).toBe(false);
    expect(briefIsStale(brief({ date: '2026-09-09' }), now)).toBe(true);
    expect(briefIsStale(null, now)).toBe(true);
    expect(briefIsStale(undefined, now)).toBe(true);
    // Late evening ET is still the same session's brief.
    expect(briefIsStale(brief(), new Date('2026-09-11T02:00:00Z'))).toBe(false);
  });

  it('briefDateLabel formats without timezone drift', () => {
    expect(briefDateLabel('2026-09-10')).toBe('Thu, Sep 10');
    expect(briefDateLabel('garbage')).toBe('garbage');
  });

  it('briefTimeLabel renders the generation time in ET, not a fixed 9:40', () => {
    expect(briefTimeLabel('2026-09-10T14:42:07Z')).toBe('10:42 AM ET');
    expect(briefTimeLabel('2026-09-10T13:40:00Z')).toBe('9:40 AM ET');
    expect(briefTimeLabel(undefined)).toBe('');
    expect(briefTimeLabel('nope')).toBe('');
  });

  it('actionableIdeas keeps only ideas the account can place', () => {
    const idea = (symbol: string, fits: boolean) => ({
      symbol, structure: 'long stock', legs: 'buy 1', direction: 'bullish' as const, why: 'w',
      getting_paid: 'g', max_loss_usd: 10, capital_required_usd: 10, invalidation: 'i',
      key_risk: 'k', fits_account: fits, confidence: 3,
    });
    const b = brief({ ideas: [idea('F', true), idea('NVDA', false)] });
    expect(actionableIdeas(b).map((i) => i.symbol)).toEqual(['F']);
    expect(actionableIdeas(null)).toEqual([]);
  });
});
