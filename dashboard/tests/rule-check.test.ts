import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
// D4: lrange is now called by readMonthIndex for trades:index:YYYY-MM keys.
// The mock routes lrange for month-index keys through kvGet so existing test
// data (which sets kvGet to return an array for those keys) continues to work.
const kvLrange = vi.fn(async (k: string) => {
  const val = await kvGet(k);
  return Array.isArray(val) ? val : [];
});
const kvDel = vi.fn().mockResolvedValue(1);
const kvRpush = vi.fn().mockResolvedValue(1);
vi.mock('../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, lrange: kvLrange, del: kvDel, rpush: kvRpush }),
}));

const fetchEarningsDate = vi.fn();
vi.mock('../api/_lib/fundamentals-fetch', () => ({ fetchEarningsDate }));

import type { ManualRule } from '../api/_lib/rules-types';

const mkRule = (over: Partial<ManualRule>): ManualRule => ({
  id: 'r-1', title: 'test rule', body: 'b', severity: 'block', triggers: [],
  source: 'manual', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z',
  ...over,
});

describe('runRuleChecks — trigger DSL evaluator', () => {
  beforeEach(() => { kvGet.mockReset(); fetchEarningsDate.mockReset(); });

  it('rule fires when ALL triggers match', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        triggers: [
          { type: 'symbol_in', symbols: ['TSLA'] },
          { type: 'side', value: 'sell' },
        ],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
      account: 'conservative_paper',
    });
    expect(violations.find((v) => v.rule === 'r-1')).toBeDefined();
    expect(violations.find((v) => v.rule === 'r-1')?.severity).toBe('block');
  });

  it('rule does NOT fire when one trigger fails', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        triggers: [
          { type: 'symbol_in', symbols: ['TSLA'] },
          { type: 'side', value: 'sell' },
        ],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'AAPL', side: 'STO', qty: 1,
      account: 'conservative_paper',
    });
    expect(violations.find((v) => v.rule === 'r-1')).toBeUndefined();
  });

  it('rule with empty triggers does NOT fire (avoids accidental match)', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({ triggers: [] })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'stock', symbol: 'F', side: 'buy', qty: 100,
      account: 'conservative_paper',
    });
    expect(violations.find((v) => v.rule === 'r-1')).toBeUndefined();
  });

  it('option_dte_lt fires when expiration within window', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'warn',
        triggers: [{ type: 'option_dte_lt', value: 7 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    // Build expiration 5 days in the future
    const exp = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
      account: 'conservative_paper', expiration: exp,
    });
    expect(violations.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('option_dte_gt fires when expiration is far out', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'warn',
        triggers: [{ type: 'option_dte_gt', value: 30 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const exp = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
      account: 'conservative_paper', expiration: exp,
    });
    expect(violations.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('open_position_count_gt counts ctx.positions for the symbol', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'warn',
        triggers: [{ type: 'open_position_count_gt', value: 2 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks(
      { asset_class: 'stock', symbol: 'F', side: 'buy', qty: 100, account: 'conservative_paper' },
      { positions: [
        { symbol: 'F', qty: 100, avg_entry_price: 12 },
        { symbol: 'F', qty: 100, avg_entry_price: 13 },
        { symbol: 'F', qty: 100, avg_entry_price: 14 },
      ] },
    );
    expect(violations.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('earnings_within_days fires when fetchEarningsDate within window', async () => {
    fetchEarningsDate.mockResolvedValue(
      new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10),
    );
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'block',
        triggers: [{ type: 'earnings_within_days', value: 7 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks(
      { asset_class: 'stock', symbol: 'TSLA', side: 'buy', qty: 10, account: 'conservative_paper' },
    );
    expect(violations.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('strike_below_cost_basis fires when CALL strike < stock avg_entry_price', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'block',
        triggers: [
          { type: 'strike_below_cost_basis' },
          { type: 'option_type', value: 'call' },
        ],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks(
      {
        asset_class: 'option', symbol: 'F', side: 'STO', qty: 1,
        account: 'conservative_paper',
        option_type: 'call', strike: 11,
      },
      { positions: [{ symbol: 'F', qty: 100, avg_entry_price: 12 }] },
    );
    expect(violations.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('tag_present fires when input.tags contains the tag', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'warn',
        triggers: [{ type: 'tag_present', tag: 'wheel' }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
      account: 'conservative_paper', tags: ['wheel', 'high-iv'],
    });
    expect(violations.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('emits warn-severity bot rule violation for symbol outside wheel', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [];
      if (k === 'bot:rules:live') return {
        wheel: { symbols: ['TSLA', 'F'], otm_pct: 0.10, dte_min: 14, dte_max: 28 },
      };
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'NFLX', side: 'STO', qty: 1,
      account: 'live', option_type: 'put',
    });
    const v = violations.find((x) => x.rule === 'bot_outside_wheel_symbols');
    expect(v).toBeDefined();
    expect(v?.severity).toBe('warn');
  });

  it('emits warn-severity bot rule violation for DTE outside wheel range', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [];
      if (k === 'bot:rules:live') return {
        wheel: { symbols: ['TSLA'], otm_pct: 0.10, dte_min: 14, dte_max: 28 },
      };
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    // 3 days out — way under dte_min (14) - 3 = 11
    const exp = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
      account: 'live', option_type: 'put', expiration: exp,
    });
    const v = violations.find((x) => x.rule === 'bot_dte_outside_wheel');
    expect(v).toBeDefined();
    expect(v?.severity).toBe('warn');
  });

  it('uses bot:rules:manual for manual_paper account', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [];
      if (k === 'bot:rules:manual') return {
        wheel: { symbols: ['F'], otm_pct: 0.10, dte_min: 14, dte_max: 28 },
      };
      // Should NOT read conservative or aggressive
      if (k === 'bot:rules:conservative' || k === 'bot:rules:aggressive') {
        return { wheel: { symbols: ['EVERYTHING'], otm_pct: 0, dte_min: 0, dte_max: 999 } };
      }
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
      account: 'manual_paper', option_type: 'put',
    });
    // TSLA not in manual's [F] symbols → fires
    expect(violations.find((v) => v.rule === 'bot_outside_wheel_symbols')).toBeDefined();
  });

  it('blocks come before warns in the returned array', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [
        mkRule({ id: 'r-warn', severity: 'warn', triggers: [{ type: 'asset_class', value: 'stock' }] }),
        mkRule({ id: 'r-block', severity: 'block', triggers: [{ type: 'symbol_in', symbols: ['F'] }] }),
      ];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'stock', symbol: 'F', side: 'buy', qty: 100, account: 'conservative_paper',
    });
    expect(violations.length).toBeGreaterThanOrEqual(2);
    const blockIdx = violations.findIndex((v) => v.severity === 'block');
    const warnIdx = violations.findIndex((v) => v.severity === 'warn');
    expect(blockIdx).toBeLessThan(warnIdx);
  });

  it('runStubRuleChecks is exported as a backward-compat alias', async () => {
    const mod = await import('../api/_lib/rule-check');
    expect(mod.runStubRuleChecks).toBe(mod.runRuleChecks);
  });

  it('emits warn when spread risk exceeds max_risk_per_spread cap', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        id: 'r1', title: 'Max risk per spread', severity: 'warn',
        triggers: [{ type: 'max_risk_per_spread', max_dollars: 50 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'spread',
      symbol: 'AAL',
      qty: 1,
      account: 'manual_paper',
      spread: { width: 1.0, net_credit: 0.25, max_loss: 0.75 },
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'r1', severity: 'warn' })
    );
  });

  it('does not fire max_risk_per_spread when risk is under cap', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        id: 'r1', title: 'Max risk per spread', severity: 'warn',
        triggers: [{ type: 'max_risk_per_spread', max_dollars: 100 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'spread', symbol: 'AAL', qty: 1, account: 'manual_paper',
      spread: { width: 1.0, net_credit: 0.25, max_loss: 0.75 },
    });
    expect(violations.filter((v) => v.rule === 'r1')).toHaveLength(0);
  });

  describe('recent_loss_within_minutes', () => {
    const mkTrade = (over: Record<string, unknown>) => ({
      id: 'T-2026-05-01-001',
      account: 'manual_paper',
      asset_class: 'option',
      symbol: 'AAL',
      side: 'STO',
      qty: 1,
      submitted_at: '2026-05-01T10:00:00Z',
      filled_at: '2026-05-01T10:00:01Z',
      closed_at: null,
      realized_pnl: null,
      ...over,
    });

    const monthKey = () => {
      const d = new Date();
      return `trades:index:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };

    it('fires when most-recent closed trade is a loss within the window', async () => {
      const closedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      kvGet.mockImplementation(async (k: string) => {
        if (k === 'rules:manual') return [mkRule({
          severity: 'warn',
          triggers: [{ type: 'recent_loss_within_minutes', minutes: 30 }],
        })];
        if (k === monthKey()) return ['T-x-1'];
        if (k === 'trade:T-x-1') return mkTrade({
          account: 'manual_paper', closed_at: closedAt, realized_pnl: -25,
        });
        return null;
      });
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
        account: 'manual_paper',
      });
      expect(violations.find((v) => v.rule === 'r-1')).toBeDefined();
    });

    it('does NOT fire when most-recent closed trade is older than window', async () => {
      const closedAt = new Date(Date.now() - 90 * 60_000).toISOString();
      kvGet.mockImplementation(async (k: string) => {
        if (k === 'rules:manual') return [mkRule({
          severity: 'warn',
          triggers: [{ type: 'recent_loss_within_minutes', minutes: 30 }],
        })];
        if (k === monthKey()) return ['T-x-1'];
        if (k === 'trade:T-x-1') return mkTrade({
          account: 'manual_paper', closed_at: closedAt, realized_pnl: -25,
        });
        return null;
      });
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
        account: 'manual_paper',
      });
      expect(violations.find((v) => v.rule === 'r-1')).toBeUndefined();
    });

    it('does NOT fire when most-recent closed trade is a winner', async () => {
      const closedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      kvGet.mockImplementation(async (k: string) => {
        if (k === 'rules:manual') return [mkRule({
          severity: 'warn',
          triggers: [{ type: 'recent_loss_within_minutes', minutes: 30 }],
        })];
        if (k === monthKey()) return ['T-x-1'];
        if (k === 'trade:T-x-1') return mkTrade({
          account: 'manual_paper', closed_at: closedAt, realized_pnl: 25,
        });
        return null;
      });
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
        account: 'manual_paper',
      });
      expect(violations.find((v) => v.rule === 'r-1')).toBeUndefined();
    });

    it('does NOT fire when account has no closed trades', async () => {
      kvGet.mockImplementation(async (k: string) => {
        if (k === 'rules:manual') return [mkRule({
          severity: 'warn',
          triggers: [{ type: 'recent_loss_within_minutes', minutes: 30 }],
        })];
        return null;
      });
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
        account: 'manual_paper',
      });
      expect(violations.find((v) => v.rule === 'r-1')).toBeUndefined();
    });

    it('only considers trades from the matching account', async () => {
      const closedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      kvGet.mockImplementation(async (k: string) => {
        if (k === 'rules:manual') return [mkRule({
          severity: 'warn',
          triggers: [{ type: 'recent_loss_within_minutes', minutes: 30 }],
        })];
        if (k === monthKey()) return ['T-x-1'];
        // Recent loss exists, but on a DIFFERENT account
        if (k === 'trade:T-x-1') return mkTrade({
          account: 'conservative_paper', closed_at: closedAt, realized_pnl: -25,
        });
        return null;
      });
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
        account: 'manual_paper',
      });
      expect(violations.find((v) => v.rule === 'r-1')).toBeUndefined();
    });
  });

  it('blocks when severity is block and spread risk exceeds cap', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        id: 'r1', title: 'Max risk per spread', severity: 'block',
        triggers: [{ type: 'max_risk_per_spread', max_dollars: 50 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'spread', symbol: 'AAL', qty: 1, account: 'manual_paper',
      spread: { width: 1.0, net_credit: 0.25, max_loss: 0.75 },
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'r1', severity: 'block' })
    );
  });

  describe('short_put_too_close_otm (built-in OTM nudge)', () => {
    it('fires warn for a bare STO put closer than 7% OTM', async () => {
      kvGet.mockResolvedValue(null);
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      // ARM example: short $390 put, spot $413.79 → ~5.75% OTM
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'ARM', side: 'STO', qty: 1,
        account: 'manual_paper', option_type: 'put',
        strike: 390, underlying_price: 413.79,
      });
      const v = violations.find((x) => x.rule === 'short_put_too_close_otm');
      expect(v).toBeDefined();
      expect(v?.severity).toBe('warn');
      expect(v?.message).toContain('5.7% OTM');
    });

    it('does NOT fire when the short put is >= 7% OTM', async () => {
      kvGet.mockResolvedValue(null);
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      // $380 put, spot $413.79 → ~8.2% OTM
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'ARM', side: 'STO', qty: 1,
        account: 'manual_paper', option_type: 'put',
        strike: 380, underlying_price: 413.79,
      });
      expect(violations.find((x) => x.rule === 'short_put_too_close_otm')).toBeUndefined();
    });

    it('fires for the short leg of a put credit spread too close to the money', async () => {
      kvGet.mockResolvedValue(null);
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'spread', symbol: 'ARM', qty: 1, account: 'manual_paper',
        spread_type: 'put_credit', strike: 390, option_type: 'put',
        underlying_price: 413.79,
        spread: { width: 40, net_credit: 13.49, max_loss: 26.51 },
      });
      expect(violations.find((x) => x.rule === 'short_put_too_close_otm')).toBeDefined();
    });

    it('does NOT fire for a call credit spread (calls are not short puts)', async () => {
      kvGet.mockResolvedValue(null);
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'spread', symbol: 'ARM', qty: 1, account: 'manual_paper',
        spread_type: 'call_credit', strike: 420, option_type: 'call',
        underlying_price: 413.79,
        spread: { width: 5, net_credit: 1.0, max_loss: 4.0 },
      });
      expect(violations.find((x) => x.rule === 'short_put_too_close_otm')).toBeUndefined();
    });

    it('does NOT fire for a long put (BTO)', async () => {
      kvGet.mockResolvedValue(null);
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'ARM', side: 'BTO', qty: 1,
        account: 'manual_paper', option_type: 'put',
        strike: 410, underlying_price: 413.79,
      });
      expect(violations.find((x) => x.rule === 'short_put_too_close_otm')).toBeUndefined();
    });

    it('does NOT fire when underlying price is unavailable', async () => {
      kvGet.mockResolvedValue(null);
      const { runRuleChecks } = await import('../api/_lib/rule-check');
      const violations = await runRuleChecks({
        asset_class: 'option', symbol: 'ARM', side: 'STO', qty: 1,
        account: 'manual_paper', option_type: 'put',
        strike: 390, underlying_price: null,
      });
      expect(violations.find((x) => x.rule === 'short_put_too_close_otm')).toBeUndefined();
    });
  });

  describe('shortPutOtmViolation (pure helper)', () => {
    it('flags an at/in-the-money short put with the ITM message', async () => {
      const { shortPutOtmViolation } = await import('../api/_lib/rule-check');
      const v = shortPutOtmViolation({
        asset_class: 'option', symbol: 'ARM', qty: 1, account: 'manual_paper',
        side: 'STO', option_type: 'put', strike: 415, underlying_price: 413.79,
      });
      expect(v).not.toBeNull();
      expect(v?.message).toContain('at/in the money');
    });

    it('returns null exactly at the 7% threshold', async () => {
      const { shortPutOtmViolation } = await import('../api/_lib/rule-check');
      // strike exactly 7% below spot → otmPct === 0.07 → not "less than"
      const spot = 100;
      const v = shortPutOtmViolation({
        asset_class: 'option', symbol: 'X', qty: 1, account: 'manual_paper',
        side: 'STO', option_type: 'put', strike: 93, underlying_price: spot,
      });
      expect(v).toBeNull();
    });
  });
});
