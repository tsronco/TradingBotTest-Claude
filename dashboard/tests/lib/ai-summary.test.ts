import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  buildOptionsDigest,
  extractText,
  extractCitations,
  buildUserPrompt,
  type QuoteInfo,
} from '../../api/_lib/ai-summary';

const NOW = new Date('2026-06-25T15:00:00Z');

describe('daysUntil', () => {
  it('returns whole calendar days to a future date', () => {
    expect(daysUntil('2026-06-30T15:00:00Z', NOW)).toBe(5);
  });
  it('returns a negative number for a past date', () => {
    expect(daysUntil('2026-06-20T15:00:00Z', NOW)).toBe(-5);
  });
  it('returns null for null/garbage', () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('not-a-date', NOW)).toBeNull();
  });
});

describe('buildOptionsDigest', () => {
  const contracts = [
    // nearest expiration (future)
    { symbol: 'X260703C00100000', expiration_date: '2026-07-03', strike_price: '100', type: 'call' as const, open_interest: '500' },
    { symbol: 'X260703P00100000', expiration_date: '2026-07-03', strike_price: '100', type: 'put' as const, open_interest: '1500' },
    { symbol: 'X260703C00120000', expiration_date: '2026-07-03', strike_price: '120', type: 'call' as const, open_interest: '100' },
    // a later expiration — should still count toward expirations_count
    { symbol: 'X260710C00100000', expiration_date: '2026-07-10', strike_price: '100', type: 'call' as const, open_interest: '50' },
    // a past expiration — must be ignored entirely
    { symbol: 'X260601C00100000', expiration_date: '2026-06-01', strike_price: '100', type: 'call' as const, open_interest: '9999' },
  ];
  const snapshots = {
    X260703C00100000: { impliedVolatility: 0.40 },
    X260703P00100000: { impliedVolatility: 0.50 },
  };

  it('picks the nearest forward expiration and counts forward expirations only', () => {
    const d = buildOptionsDigest(101, contracts, snapshots, null, NOW);
    expect(d.nearest_expiration).toBe('2026-07-03');
    expect(d.expirations_count).toBe(2); // 07-03 and 07-10, not the past 06-01
  });

  it('computes ATM IV as the percent average of the nearest-strike call + put', () => {
    const d = buildOptionsDigest(101, contracts, snapshots, null, NOW);
    // strike 100 is nearest to spot 101 for both legs; (0.40 + 0.50)/2 = 0.45 → 45%
    expect(d.atm_iv_pct).toBe(45);
  });

  it('computes the put/call open-interest ratio on the nearest expiration', () => {
    const d = buildOptionsDigest(101, contracts, snapshots, null, NOW);
    // puts: 1500 ; calls: 500 + 100 = 600 → 2.5
    expect(d.put_call_oi_ratio).toBe(2.5);
  });

  it('carries earnings date through and computes days-to-earnings', () => {
    const d = buildOptionsDigest(101, contracts, snapshots, '2026-07-01', NOW);
    expect(d.earnings_date).toBe('2026-07-01');
    // 2026-07-01 parses to midnight UTC; from 06-25T15:00Z that's ~5.4 days → rounds to 5.
    expect(d.days_to_earnings).toBe(5);
  });

  it('degrades gracefully with no spot / no snapshots', () => {
    const d = buildOptionsDigest(null, contracts, {}, null, NOW);
    expect(d.atm_iv_pct).toBeNull();
    expect(d.put_call_oi_ratio).toBeNull();
    // still reports expirations from contract metadata
    expect(d.expirations_count).toBe(2);
  });
});

describe('extractText', () => {
  it('joins only text blocks, ignoring tool-use/tool-result', () => {
    const content = [
      { type: 'server_tool_use', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', content: [] },
      { type: 'text', text: 'Wendy fell 5% ' },
      { type: 'text', text: 'after a CFO appointment.' },
    ];
    expect(extractText(content)).toBe('Wendy fell 5% after a CFO appointment.');
  });
  it('returns empty string for non-array / empty', () => {
    expect(extractText(null)).toBe('');
    expect(extractText([])).toBe('');
  });
});

describe('buildUserPrompt', () => {
  const quote: QuoteInfo = {
    price: 7.44, change: -0.42, changePct: -5.34, dayHigh: 7.9, dayLow: 7.3, volume: 12_345_678,
  };
  const digest = {
    nearest_expiration: '2026-07-03',
    expirations_count: 12,
    atm_iv_pct: 62.5,
    put_call_oi_ratio: 1.8,
    earnings_date: '2026-07-30',
    days_to_earnings: 35,
  };

  it('includes symbol, the move, and the options facts', () => {
    const p = buildUserPrompt('WEN', quote, digest, ['Wendy names new CFO']);
    expect(p).toContain('Stock: WEN');
    expect(p).toContain('down $0.42 (-5.34%)');
    expect(p).toContain('At-the-money implied volatility: 62.5%');
    expect(p).toContain('Put/call open-interest ratio');
    expect(p).toContain('Next earnings: 2026-07-30');
    expect(p).toContain('Wendy names new CFO');
  });

  it('handles missing options data without throwing', () => {
    const p = buildUserPrompt('WEN', { price: null, change: null, changePct: null, dayHigh: null, dayLow: null, volume: null }, {
      nearest_expiration: null, expirations_count: 0, atm_iv_pct: null, put_call_oi_ratio: null, earnings_date: null, days_to_earnings: null,
    }, []);
    expect(p).toContain('Stock: WEN');
    expect(p).toContain('implied volatility: unavailable');
    expect(p).toContain('Next earnings: unknown');
  });
});

describe('extractCitations', () => {
  it('prefers citations attached to the model text blocks', () => {
    const content = [
      { type: 'web_search_tool_result', content: [
        { type: 'web_search_result', url: 'https://searched-only.com/a', title: 'Searched A' },
      ] },
      { type: 'text', text: 'Snap fell on the Specs launch.', citations: [
        { type: 'web_search_result_location', url: 'https://reuters.com/snap', title: 'Reuters — Snap' },
        { type: 'web_search_result_location', url: 'https://bloomberg.com/snap', title: 'Bloomberg — Snap' },
      ] },
    ];
    const out = extractCitations(content);
    expect(out).toEqual([
      { url: 'https://reuters.com/snap', title: 'Reuters — Snap' },
      { url: 'https://bloomberg.com/snap', title: 'Bloomberg — Snap' },
    ]);
    // The "searched but not cited" page is NOT included when real citations exist.
    expect(out.find((s) => s.url.includes('searched-only'))).toBeUndefined();
  });

  it('falls back to searched pages when there are no inline citations', () => {
    const content = [
      { type: 'web_search_tool_result', content: [
        { type: 'web_search_result', url: 'https://cnbc.com/x', title: 'CNBC' },
      ] },
      { type: 'text', text: 'A summary with no citations.' },
    ];
    expect(extractCitations(content)).toEqual([{ url: 'https://cnbc.com/x', title: 'CNBC' }]);
  });

  it('dedupes by URL, caps at 6, and falls back to URL when title is missing', () => {
    const cites = Array.from({ length: 9 }, (_, i) => ({ url: `https://site.com/${i}`, title: '' }));
    cites.push({ url: 'https://site.com/0', title: '' }); // duplicate of the first
    const out = extractCitations([{ type: 'text', text: 't', citations: cites }]);
    expect(out).toHaveLength(6);
    expect(out[0]).toEqual({ url: 'https://site.com/0', title: 'https://site.com/0' });
    expect(new Set(out.map((s) => s.url)).size).toBe(6); // all unique
  });

  it('returns [] for the no-search / non-array / malformed cases', () => {
    expect(extractCitations(null)).toEqual([]);
    expect(extractCitations('nope')).toEqual([]);
    expect(extractCitations([{ type: 'text', text: 'plain, no tools' }])).toEqual([]);
    expect(extractCitations([{ type: 'text', citations: [{ title: 'no url' }] }])).toEqual([]);
  });
});
