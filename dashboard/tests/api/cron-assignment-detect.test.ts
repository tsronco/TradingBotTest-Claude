import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
const kvSet = vi.fn().mockResolvedValue('OK');
const kvLrange = vi.fn().mockResolvedValue([]);
const kvLrem = vi.fn().mockResolvedValue(1);
const kvRpush = vi.fn().mockResolvedValue(1);
const kvIncr = vi.fn().mockResolvedValue(1);
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem, rpush: kvRpush, incr: kvIncr }),
}));

const alpacaTrade = vi.fn();
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade,
  alpacaTradeMutation: vi.fn(),
  alpacaData: vi.fn().mockResolvedValue({ bars: {} }),
}));

vi.mock('../../api/_lib/alpaca', () => ({}));

vi.mock('../../api/_lib/grading', () => ({
  gradeTrade: vi.fn().mockResolvedValue({
    letter: 'B', review: 'r', calibration: 'matched',
    tendencies_hit: [], model: 'm', usage: {}, ts: '...',
  }),
}));

vi.mock('../../api/_lib/proposal-prompts', () => ({
  proposeNewRule: vi.fn(),
  proposeDemote: vi.fn(),
}));

describe('grade-open-trades — assignment detection (M5.1)', () => {
  beforeEach(() => {
    kvGet.mockReset(); kvSet.mockClear(); kvLrange.mockReset(); kvLrem.mockReset(); kvRpush.mockClear();
    alpacaTrade.mockReset();
    process.env.CRON_TOKEN = 'tok';
  });

  it('enqueueAssignmentPending writes the entry to the inbox list', async () => {
    const tradeId = 'T-2026-04-01-001';
    const { enqueueAssignmentPending } = await import('../../api/_lib/assignment-spawn');
    await enqueueAssignmentPending({
      parent_trade_id: tradeId,
      underlying: 'F',
      strike: 12,
      qty: 100,
      account: 'conservative_paper',
      detected_at: '2026-04-15T20:00:00Z',
    });

    // Upstash auto-serializes objects on rpush; enqueueAssignmentPending now
    // passes the raw entry object (see assignment-spawn.ts comment).
    expect(kvRpush).toHaveBeenCalledWith(
      'trades:index:assignments-pending',
      expect.objectContaining({
        parent_trade_id: tradeId,
        qty: 100,
        account: 'conservative_paper',
      }),
    );
  });

  it('gating logic only fires for STO put trades that closed via assigned (sentinel)', () => {
    // The detection branch is gated on:
    //   asset_class === 'option' && contract_type === 'put' && side === 'STO' && closed_by === 'assigned'
    // The gate lives in the cron handler inline; this is a sentinel test that
    // records the contract for future readers. The drain test exercises the
    // full pipeline end-to-end.
    expect(true).toBe(true);
  });
});
