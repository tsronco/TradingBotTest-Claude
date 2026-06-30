import { describe, expect, it, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
const fundamentalsMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet }) }));
vi.mock('../../api/_lib/fundamentals-fetch', () => ({
  fetchEarningsDate: (...args: any[]) => fundamentalsMock(...args),
}));

beforeEach(() => { kvGet.mockReset(); fundamentalsMock.mockReset(); });

describe('runStubRuleChecks', () => {
  it('flags >20 shares as sizing_1x info', async () => {
    kvGet.mockResolvedValue(null);
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 25, account: 'manual_paper',
    });
    expect(out.find((w) => w.rule === 'sizing_1x')?.severity).toBe('info');
  });

  it('flags >1 contract as sizing_1x info', async () => {
    kvGet.mockResolvedValue(null);
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'option', symbol: 'TSLA', qty: 2, account: 'manual_paper',
    });
    expect(out.find((w) => w.rule === 'sizing_1x')?.severity).toBe('info');
  });

  it('flags earnings within 7 days as warn', async () => {
    kvGet.mockResolvedValue(null);
    const today = new Date();
    const future = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000);
    fundamentalsMock.mockResolvedValue(future.toISOString().slice(0, 10));
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 10, account: 'manual_paper',
    });
    expect(out.find((w) => w.rule === 'earnings_within_7d')?.severity).toBe('warn');
  });

  it('skips earnings check silently when fundamentals unavailable', async () => {
    kvGet.mockResolvedValue(null);
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 10, account: 'manual_paper',
    });
    expect(out.find((w) => w.rule === 'earnings_within_7d')).toBeUndefined();
  });

  it('flags bot wheel overlap when symbol in stage 1 of the manual bot', async () => {
    kvGet.mockImplementation((key: string) => {
      if (key === 'bot:state:manual') return Promise.resolve({ TSLA: { stage: 1 } });
      if (key === 'bot:state:live') return Promise.resolve({});
      return Promise.resolve(null);
    });
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 10, account: 'manual_paper',
    });
    expect(out.find((w) => w.rule === 'bot_wheel_overlap')?.severity).toBe('warn');
  });

  it('returns empty array when no checks fire', async () => {
    kvGet.mockResolvedValue({});
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 10, account: 'manual_paper',
    });
    expect(out).toEqual([]);
  });
});
