import { describe, expect, it, vi, beforeEach } from 'vitest';
import { allocateTradeId, currentMonth, currentDay } from '../../api/_lib/trade-ids';

const incrMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ incr: (...args: unknown[]) => incrMock(...args) }),
}));

beforeEach(() => {
  incrMock.mockReset();
});

describe('allocateTradeId', () => {
  it('returns T-YYYY-MM-DD-NNN with NNN zero-padded to 3 digits', async () => {
    incrMock.mockResolvedValueOnce(1);
    const id = await allocateTradeId(new Date('2026-05-04T13:30:00Z'));
    expect(id).toBe('T-2026-05-04-001');
  });

  it('handles three-digit counters', async () => {
    incrMock.mockResolvedValueOnce(42);
    const id = await allocateTradeId(new Date('2026-05-04T13:30:00Z'));
    expect(id).toBe('T-2026-05-04-042');
  });

  it('uses the YYYY-MM-DD UTC date for the counter key', async () => {
    incrMock.mockResolvedValueOnce(1);
    await allocateTradeId(new Date('2026-12-31T23:59:00Z'));
    expect(incrMock).toHaveBeenCalledWith('trades:counter:2026-12-31');
  });
});

describe('currentMonth / currentDay', () => {
  it('formats UTC dates correctly', () => {
    const d = new Date('2026-05-04T13:30:00Z');
    expect(currentMonth(d)).toBe('2026-05');
    expect(currentDay(d)).toBe('2026-05-04');
  });
});
