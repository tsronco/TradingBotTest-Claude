/**
 * Pure derivations over the autonomous agent account's state document.
 *
 * The fixtures mirror the real shape written by agent_trader.py (see
 * agent_state.json in the repo root) rather than an idealized one, so the
 * defensive-optional handling is actually exercised.
 */
import { describe, it, expect } from 'vitest';
import {
  openPositions,
  closedTrades,
  agentStats,
  confidenceCalibration,
  openUnrealizedPnl,
  type AgentClosedTrade,
  type AgentState,
} from '../../src/lib/agent-state';

function closed(pnl: number | null, confidence?: number, extra: Partial<AgentClosedTrade> = {}): AgentClosedTrade {
  return {
    opened_at: '2026-08-14T18:12:55Z',
    closed_at: '2026-08-17T16:12:41Z',
    legs: [{ asset: 'option', qty: 1, side: 'sell', symbol: 'DIS260828P00103000' }],
    thesis: confidence === undefined ? {} : { confidence },
    outcome: pnl === null ? {} : { estimated_pnl: pnl },
    ...extra,
  };
}

describe('openPositions', () => {
  it('returns [] for missing / empty state rather than throwing', () => {
    expect(openPositions(null)).toEqual([]);
    expect(openPositions(undefined)).toEqual([]);
    expect(openPositions({})).toEqual([]);
    expect(openPositions({ positions: {} })).toEqual([]);
  });

  it('attaches the dict key as id and sorts newest-opened first', () => {
    const state: AgentState = {
      positions: {
        older: { opened_at: '2026-08-14T18:00:00Z' },
        newer: { opened_at: '2026-08-17T18:00:00Z' },
      },
    };
    expect(openPositions(state).map((p) => p.id)).toEqual(['newer', 'older']);
  });

  it('tolerates a position with no opened_at (sorts it last, does not drop it)', () => {
    const state: AgentState = {
      positions: { a: { opened_at: '2026-08-17T18:00:00Z' }, b: {} },
    };
    expect(openPositions(state).map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('closedTrades', () => {
  it('sorts newest close first and does not mutate the source array', () => {
    const source: AgentClosedTrade[] = [
      { closed_at: '2026-08-14T00:00:00Z' },
      { closed_at: '2026-08-17T00:00:00Z' },
    ];
    const state: AgentState = { closed: source };
    expect(closedTrades(state).map((t) => t.closed_at)).toEqual([
      '2026-08-17T00:00:00Z',
      '2026-08-14T00:00:00Z',
    ]);
    // the caller's array order is untouched
    expect(source[0].closed_at).toBe('2026-08-14T00:00:00Z');
  });

  it('returns [] for missing state', () => {
    expect(closedTrades(null)).toEqual([]);
  });
});

describe('agentStats', () => {
  it('splits wins and losses and sums total P&L', () => {
    const s = agentStats([closed(100), closed(-50), closed(-30)]);
    expect(s.total).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.totalPnl).toBe(20);
    expect(s.winRate).toBeCloseTo(33.333, 2);
  });

  it('computes avg win / avg loss ratio — the headline metric', () => {
    const s = agentStats([closed(200), closed(100), closed(-50)]);
    expect(s.avgWin).toBe(150);
    expect(s.avgLoss).toBe(-50);
    expect(s.winLossRatio).toBe(3);
  });

  it('counts a scratch (exactly 0) as neither win nor loss but keeps it in total', () => {
    const s = agentStats([closed(0), closed(100)]);
    expect(s.total).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(0);
    expect(s.winRate).toBe(100); // 1 win of 1 decided trade
    expect(s.totalPnl).toBe(100);
  });

  it('quarantines trades with no usable P&L instead of treating them as scratches', () => {
    const s = agentStats([closed(null), closed(100)]);
    expect(s.unknown).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(0);
    expect(s.totalPnl).toBe(100);
  });

  it('ignores a non-finite P&L (NaN from a partial harness write)', () => {
    const s = agentStats([{ outcome: { estimated_pnl: NaN } }, closed(50)]);
    expect(s.unknown).toBe(1);
    expect(s.totalPnl).toBe(50);
  });

  it('tallies blind-spot vs anticipated losses and graded count', () => {
    const s = agentStats([
      closed(-10, 3, { grade: { graded: true, loss_type: 'blind_spot' } }),
      closed(-20, 3, { grade: { graded: true, loss_type: 'anticipated' } }),
      closed(30, 3, { grade: { graded: false } }),
    ]);
    expect(s.blindSpot).toBe(1);
    expect(s.anticipated).toBe(1);
    expect(s.graded).toBe(2);
  });

  it('returns null rates/ratios on an empty record rather than NaN or 0', () => {
    const s = agentStats([]);
    expect(s.winRate).toBeNull();
    expect(s.avgWin).toBeNull();
    expect(s.avgLoss).toBeNull();
    expect(s.winLossRatio).toBeNull();
    expect(s.totalPnl).toBe(0);
  });

  it('leaves the ratio null when there are wins but no losses yet', () => {
    const s = agentStats([closed(100)]);
    expect(s.avgWin).toBe(100);
    expect(s.avgLoss).toBeNull();
    expect(s.winLossRatio).toBeNull();
  });
});

describe('confidenceCalibration', () => {
  it('always returns all 5 buckets so the axis is stable', () => {
    const b = confidenceCalibration([]);
    expect(b).toHaveLength(5);
    expect(b.map((x) => x.confidence)).toEqual([1, 2, 3, 4, 5]);
    expect(b.every((x) => x.trades === 0 && x.winRate === null)).toBe(true);
  });

  it('buckets trades by self-rated confidence', () => {
    const b = confidenceCalibration([
      closed(100, 5), closed(-50, 5), closed(-20, 1),
    ]);
    expect(b[4].trades).toBe(2);
    expect(b[4].wins).toBe(1);
    expect(b[4].winRate).toBe(50);
    expect(b[4].totalPnl).toBe(50);
    expect(b[0].trades).toBe(1);
    expect(b[0].winRate).toBe(0);
  });

  it('ignores missing / out-of-range / non-integer confidence values', () => {
    const b = confidenceCalibration([
      closed(10), closed(10, 0), closed(10, 6), closed(10, 2.5),
    ]);
    expect(b.reduce((n, x) => n + x.trades, 0)).toBe(0);
  });

  it('counts a trade toward the bucket but not the win rate when P&L is unknown', () => {
    const b = confidenceCalibration([closed(null, 4)]);
    expect(b[3].trades).toBe(1);
    expect(b[3].winRate).toBeNull();
  });
});

describe('openUnrealizedPnl', () => {
  it('sums the mid-based snapshot P&L across positions', () => {
    expect(openUnrealizedPnl([
      { last_snapshot: { unrealized_pl: -151.5 } },
      { last_snapshot: { unrealized_pl: 20 } },
    ])).toBe(-131.5);
  });

  it('returns null when nothing has been snapshotted yet (a fresh open)', () => {
    expect(openUnrealizedPnl([{ last_snapshot: null }, {}])).toBeNull();
    expect(openUnrealizedPnl([])).toBeNull();
  });

  it('skips un-snapshotted positions rather than counting them as zero', () => {
    expect(openUnrealizedPnl([
      { last_snapshot: { unrealized_pl: -57 } },
      { last_snapshot: null },
    ])).toBe(-57);
  });
});
