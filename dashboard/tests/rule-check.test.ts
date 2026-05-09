import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
vi.mock('../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet }),
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
      if (k === 'bot:rules:conservative') return {
        wheel: { symbols: ['TSLA', 'F'], otm_pct: 0.10, dte_min: 14, dte_max: 28 },
      };
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'NFLX', side: 'STO', qty: 1,
      account: 'conservative_paper', option_type: 'put',
    });
    const v = violations.find((x) => x.rule === 'bot_outside_wheel_symbols');
    expect(v).toBeDefined();
    expect(v?.severity).toBe('warn');
  });

  it('emits warn-severity bot rule violation for DTE outside wheel range', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [];
      if (k === 'bot:rules:conservative') return {
        wheel: { symbols: ['TSLA'], otm_pct: 0.10, dte_min: 14, dte_max: 28 },
      };
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    // 3 days out — way under dte_min (14) - 3 = 11
    const exp = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const violations = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'STO', qty: 1,
      account: 'conservative_paper', option_type: 'put', expiration: exp,
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
});
