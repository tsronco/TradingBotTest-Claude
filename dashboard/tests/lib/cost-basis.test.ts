import { describe, expect, it, vi } from 'vitest';
import { resolveCostBasisForCc, isCoveredCallOpen } from '../../api/_lib/cost-basis';

describe('isCoveredCallOpen', () => {
  it('true for option call STO', () => {
    expect(isCoveredCallOpen({ asset_class: 'option', side: 'STO', contract_type: 'call', symbol: 'AAPL' })).toBe(true);
  });
  it('false for put STO', () => {
    expect(isCoveredCallOpen({ asset_class: 'option', side: 'STO', contract_type: 'put', symbol: 'AAPL' })).toBe(false);
  });
  it('false for stock buy', () => {
    expect(isCoveredCallOpen({ asset_class: 'stock', side: 'buy', contract_type: null, symbol: 'AAPL' })).toBe(false);
  });
  it('false for long call BTO', () => {
    expect(isCoveredCallOpen({ asset_class: 'option', side: 'BTO', contract_type: 'call', symbol: 'AAPL' })).toBe(false);
  });
});

describe('resolveCostBasisForCc', () => {
  it('captures basis from Alpaca position for a CC', async () => {
    const fetcher = vi.fn().mockResolvedValue({ avg_entry_price: '187.34' });
    const result = await resolveCostBasisForCc(
      { asset_class: 'option', side: 'STO', contract_type: 'call', symbol: 'AAPL' },
      fetcher,
    );
    expect(result).toBe(187.34);
    expect(fetcher).toHaveBeenCalledWith('AAPL');
  });

  it('returns null when fetcher resolves null (no position / 404)', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const result = await resolveCostBasisForCc(
      { asset_class: 'option', side: 'STO', contract_type: 'call', symbol: 'AAPL' },
      fetcher,
    );
    expect(result).toBeNull();
  });

  it('returns null and does NOT call fetcher for non-CC trades', async () => {
    const fetcher = vi.fn();
    const result = await resolveCostBasisForCc(
      { asset_class: 'option', side: 'STO', contract_type: 'put', symbol: 'AAPL' },
      fetcher,
    );
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null and does NOT call fetcher for stock orders', async () => {
    const fetcher = vi.fn();
    const result = await resolveCostBasisForCc(
      { asset_class: 'stock', side: 'buy', contract_type: null, symbol: 'AAPL' },
      fetcher,
    );
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null when fetcher throws', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await resolveCostBasisForCc(
      { asset_class: 'option', side: 'STO', contract_type: 'call', symbol: 'AAPL' },
      fetcher,
    );
    expect(result).toBeNull();
  });

  it('returns null when avg_entry_price is missing or unparseable', async () => {
    const fetcher = vi.fn().mockResolvedValue({ avg_entry_price: 'not-a-number' });
    const result = await resolveCostBasisForCc(
      { asset_class: 'option', side: 'STO', contract_type: 'call', symbol: 'AAPL' },
      fetcher,
    );
    expect(result).toBeNull();
  });
});
