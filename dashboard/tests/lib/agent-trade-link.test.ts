/**
 * Joining a dashboard trade record to the agent's own record of it.
 *
 * The two are matched at render time rather than copied at import time, so the
 * matching has to be exact: attributing one trade's thesis to another would be
 * worse than showing nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  linkAgentRecord,
  tradeLegKey,
  agentLegKey,
  confidenceToGrade,
  confidenceStars,
} from '../../src/lib/agent-trade-link';
import type { AgentState } from '../../src/lib/agent-state';
import type { Trade } from '../../src/lib/trade-types';

const DIS_SHORT = 'DIS260828P00103000';
const DIS_LONG = 'DIS260828P00100000';
const CVS_SHORT = 'CVS260925C00103000';
const CVS_LONG = 'CVS260925C00096000';

function spreadTrade(over: Partial<Trade> = {}): Trade {
  return {
    account: 'agent_paper',
    asset_class: 'spread',
    symbol: 'DIS',
    contract_symbol: DIS_SHORT,
    filled_at: '2026-08-14T18:12:55Z',
    submitted_at: '2026-08-14T18:12:55Z',
    spread: {
      short_leg: { occ: DIS_SHORT },
      long_leg: { occ: DIS_LONG },
    },
    ...over,
  } as unknown as Trade;
}

const STATE: AgentState = {
  positions: {
    'order-cvs': {
      opened_at: '2026-08-17T18:12:45Z',
      legs: [
        { symbol: CVS_LONG, side: 'buy', qty: 3 },
        { symbol: CVS_SHORT, side: 'sell', qty: 3 },
      ],
      thesis: { thesis: 'CVS is the lowest IV in the shortlist.', confidence: 3 },
    },
  },
  closed: [
    {
      opened_at: '2026-08-14T17:02:58Z',
      closed_at: '2026-08-17T16:12:46Z',
      legs: [{ symbol: DIS_SHORT, side: 'sell', qty: 1 }, { symbol: DIS_LONG, side: 'buy', qty: 1 }],
      thesis: { thesis: 'first DIS unit', confidence: 3 },
      outcome: { estimated_pnl: -57, days_held: 2.96 },
      grade: { graded: true, process_grade: 'B', outcome_grade: 'D', loss_type: 'anticipated' },
    },
    {
      opened_at: '2026-08-14T18:12:55Z',
      closed_at: '2026-08-17T16:12:41Z',
      legs: [{ symbol: DIS_SHORT, side: 'sell', qty: 1 }, { symbol: DIS_LONG, side: 'buy', qty: 1 }],
      thesis: { thesis: 'second DIS unit', confidence: 4 },
      outcome: { estimated_pnl: -57, days_held: 2.92 },
      grade: { graded: true, process_grade: 'B', outcome_grade: 'D', loss_type: 'blind_spot' },
    },
  ],
};

describe('leg keys', () => {
  it('is order-independent so leg ordering cannot break a match', () => {
    expect(agentLegKey([{ symbol: DIS_LONG }, { symbol: DIS_SHORT }]))
      .toBe(agentLegKey([{ symbol: DIS_SHORT }, { symbol: DIS_LONG }]));
  });

  it('builds the same key from a spread trade record as from the agent legs', () => {
    expect(tradeLegKey(spreadTrade()))
      .toBe(agentLegKey([{ symbol: DIS_SHORT }, { symbol: DIS_LONG }]));
  });

  it('uses the contract symbol for a single-leg option', () => {
    const t = { asset_class: 'option', symbol: 'DIS', contract_symbol: DIS_SHORT, spread: undefined } as unknown as Trade;
    expect(tradeLegKey(t)).toBe(DIS_SHORT);
  });

  it('falls back to the ticker for a stock trade', () => {
    const t = { asset_class: 'stock', symbol: 'AAPL', contract_symbol: null, spread: undefined } as unknown as Trade;
    expect(tradeLegKey(t)).toBe('AAPL');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(agentLegKey([{ symbol: ' dis260828p00103000 ' }])).toBe(DIS_SHORT);
  });
});

describe('linkAgentRecord', () => {
  it('matches an open position and returns its live thesis', () => {
    const cvs = spreadTrade({
      symbol: 'CVS',
      contract_symbol: CVS_SHORT,
      filled_at: '2026-08-17T18:12:45Z',
      spread: { short_leg: { occ: CVS_SHORT }, long_leg: { occ: CVS_LONG } },
    } as Partial<Trade>);
    const link = linkAgentRecord(STATE, cvs);
    expect(link?.kind).toBe('open');
    expect(link?.thesis?.confidence).toBe(3);
    expect(link?.grade).toBeNull();
  });

  it('matches a closed position and carries its grade and outcome', () => {
    const link = linkAgentRecord(STATE, spreadTrade());
    expect(link?.kind).toBe('closed');
    expect(link?.grade?.outcome_grade).toBe('D');
    expect(link?.outcome?.estimated_pnl).toBe(-57);
  });

  it('disambiguates two units of the same structure by open time', () => {
    // Both closed records have identical legs — only the timestamp separates
    // them. Without the tie-break both rows would show the same thesis.
    const first = linkAgentRecord(STATE, spreadTrade({ filled_at: '2026-08-14T17:02:58Z' }));
    const second = linkAgentRecord(STATE, spreadTrade({ filled_at: '2026-08-14T18:12:55Z' }));
    expect(first?.thesis?.thesis).toBe('first DIS unit');
    expect(second?.thesis?.thesis).toBe('second DIS unit');
    expect(first?.thesis?.confidence).toBe(3);
    expect(second?.thesis?.confidence).toBe(4);
  });

  it('falls back to submitted_at when the trade never recorded a fill time', () => {
    const link = linkAgentRecord(
      STATE,
      spreadTrade({ filled_at: null, submitted_at: '2026-08-14T17:02:58Z' } as Partial<Trade>),
    );
    expect(link?.thesis?.thesis).toBe('first DIS unit');
  });

  it('returns null for a non-agent account even when the legs match', () => {
    // Attributing the agent's reasoning to a hand-placed trade would be a lie.
    expect(linkAgentRecord(STATE, spreadTrade({ account: 'manual_paper' } as Partial<Trade>))).toBeNull();
    expect(linkAgentRecord(STATE, spreadTrade({ account: 'live' } as Partial<Trade>))).toBeNull();
  });

  it('returns null when nothing matches rather than guessing', () => {
    const other = spreadTrade({
      spread: { short_leg: { occ: 'AAPL260828P00200000' }, long_leg: { occ: 'AAPL260828P00195000' } },
    } as Partial<Trade>);
    expect(linkAgentRecord(STATE, other)).toBeNull();
  });

  it('handles missing or empty state', () => {
    expect(linkAgentRecord(null, spreadTrade())).toBeNull();
    expect(linkAgentRecord(undefined, spreadTrade())).toBeNull();
    expect(linkAgentRecord({}, spreadTrade())).toBeNull();
  });

  it('does not match a partial leg overlap', () => {
    // One shared leg is a different position, not this one.
    const partial = spreadTrade({
      spread: { short_leg: { occ: DIS_SHORT }, long_leg: { occ: 'DIS260828P00095000' } },
    } as Partial<Trade>);
    expect(linkAgentRecord(STATE, partial)).toBeNull();
  });
});

describe('confidence display', () => {
  it('maps every valid confidence to a letter', () => {
    expect(confidenceToGrade(1)).toBe('C-');
    expect(confidenceToGrade(3)).toBe('B');
    expect(confidenceToGrade(5)).toBe('A');
  });

  it('never returns the importer placeholder for a real confidence', () => {
    for (const c of [1, 2, 3, 4, 5]) {
      expect(confidenceToGrade(c)).not.toBe('C');
    }
  });

  it('returns null for missing or out-of-range values instead of inventing one', () => {
    expect(confidenceToGrade(undefined)).toBeNull();
    expect(confidenceToGrade(null)).toBeNull();
    expect(confidenceToGrade(0)).toBeNull();
    expect(confidenceToGrade(6)).toBeNull();
    expect(confidenceToGrade(3.5)).toBeNull();
  });

  it('renders stars out of five', () => {
    expect(confidenceStars(3)).toBe('★★★☆☆');
    expect(confidenceStars(5)).toBe('★★★★★');
    expect(confidenceStars(1)).toBe('★☆☆☆☆');
    expect(confidenceStars(0)).toBeNull();
    expect(confidenceStars(undefined)).toBeNull();
  });
});
