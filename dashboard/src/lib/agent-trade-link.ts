// Join a dashboard trade record to the agent's own record of the same trade.
//
// The two live in different places on purpose. Trade records are imported from
// Alpaca's activity log and know only what the exchange saw: legs, fills,
// prices. The reasoning — why the agent opened it, what would prove it wrong,
// and how it graded itself afterwards — lives in `agent_state.json`, pushed to
// KV as `bot:agent:state`.
//
// Rather than copy the thesis into the trade record at import time (where it
// would freeze, and would be missing whenever the importer ran before the
// agent's state push), the two are matched at render time. agent_state.json
// stays the single source of truth, and a close grade appears on the trade page
// the moment the agent writes it.

import type {
  AgentState,
  AgentThesis,
  AgentGrade,
  AgentOutcome,
  AgentLeg,
} from './agent-state';
import type { Trade } from './trade-types';

export interface AgentTradeLink {
  /** Whether the agent still holds this, or has closed and graded it. */
  kind: 'open' | 'closed';
  thesis: AgentThesis | null;
  /** Hindsight grade — closed trades only. */
  grade: AgentGrade | null;
  /** Realized result — closed trades only. */
  outcome: AgentOutcome | null;
  opened_at?: string;
  closed_at?: string;
}

/** The option/stock symbols a trade record covers, as a normalized sorted key. */
export function tradeLegKey(trade: Pick<Trade, 'asset_class' | 'symbol' | 'contract_symbol' | 'spread'>): string {
  const symbols: string[] = [];
  if (trade.asset_class === 'spread' && trade.spread) {
    if (trade.spread.short_leg?.occ) symbols.push(trade.spread.short_leg.occ);
    if (trade.spread.long_leg?.occ) symbols.push(trade.spread.long_leg.occ);
  } else if (trade.contract_symbol) {
    symbols.push(trade.contract_symbol);
  } else if (trade.symbol) {
    symbols.push(trade.symbol);
  }
  return legKeyFrom(symbols);
}

/** Same normalized key, built from the agent's own leg list. */
export function agentLegKey(legs: AgentLeg[] | undefined): string {
  return legKeyFrom((legs ?? []).map((l) => l.symbol ?? ''));
}

function legKeyFrom(symbols: string[]): string {
  return symbols
    .filter(Boolean)
    .map((s) => s.trim().toUpperCase())
    .sort()
    .join('|');
}

function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Find the agent's record for a trade, or null when there isn't one.
 *
 * Matching is on the exact set of legs. When the agent opened the same
 * structure more than once — two units of one spread arrive as two separate
 * trade records with identical legs — the candidate whose `opened_at` is
 * nearest the trade's fill time wins, so each record gets its own thesis
 * rather than both collapsing onto whichever was found first.
 *
 * Open positions are preferred over closed ones on an exact tie of leg key and
 * time, because a re-opened structure's live thesis is the current one.
 */
export function linkAgentRecord(
  state: AgentState | null | undefined,
  trade: Pick<Trade, 'account' | 'asset_class' | 'symbol' | 'contract_symbol' | 'spread' | 'filled_at' | 'submitted_at'>,
): AgentTradeLink | null {
  if (!state) return null;
  // Only the agent account has agent-authored theses; matching any other
  // account's legs against them would attribute reasoning that isn't theirs.
  if (trade.account !== 'agent_paper') return null;

  const key = tradeLegKey(trade);
  if (!key) return null;

  const tradeTime = timeOf(trade.filled_at) ?? timeOf(trade.submitted_at);

  const candidates: AgentTradeLink[] = [];
  for (const pos of Object.values(state.positions ?? {})) {
    if (agentLegKey(pos.legs) === key) {
      candidates.push({
        kind: 'open',
        thesis: pos.thesis ?? null,
        grade: null,
        outcome: null,
        opened_at: pos.opened_at,
      });
    }
  }
  for (const closed of state.closed ?? []) {
    if (agentLegKey(closed.legs) === key) {
      candidates.push({
        kind: 'closed',
        thesis: closed.thesis ?? null,
        grade: closed.grade ?? null,
        outcome: closed.outcome ?? null,
        opened_at: closed.opened_at,
        closed_at: closed.closed_at,
      });
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Several units of the same structure — pick the closest open time. Ties keep
  // the open one (see doc comment); a candidate with no timestamp sorts last.
  let best = candidates[0];
  let bestDelta = Infinity;
  for (const c of candidates) {
    const t = timeOf(c.opened_at);
    const delta = tradeTime !== null && t !== null ? Math.abs(t - tradeTime) : Infinity;
    if (delta < bestDelta || (delta === bestDelta && c.kind === 'open' && best.kind !== 'open')) {
      best = c;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Letter shown in the entry-grade slot for an agent trade.
 *
 * The agent doesn't assign itself a letter — it states a 1–5 confidence at
 * entry. The importer's neutral 'C' placeholder is meaningless here and reads
 * as a real self-assessment, so map the confidence instead. This is a display
 * convention for continuity with the hand-traded accounts; the confidence
 * itself is the number to trust, and it is always shown alongside.
 *
 * The agent only opens what it believes in, so 3 is ordinary conviction rather
 * than a middling grade.
 */
export const CONFIDENCE_GRADE: Record<number, string> = {
  1: 'C-',
  2: 'C+',
  3: 'B',
  4: 'A-',
  5: 'A',
};

export function confidenceToGrade(confidence: number | null | undefined): string | null {
  if (typeof confidence !== 'number' || !Number.isInteger(confidence)) return null;
  return CONFIDENCE_GRADE[confidence] ?? null;
}

/** "★★★☆☆" — a compact, sortable rendering of a 1–5 confidence. */
export function confidenceStars(confidence: number | null | undefined): string | null {
  if (typeof confidence !== 'number' || !Number.isInteger(confidence)) return null;
  if (confidence < 1 || confidence > 5) return null;
  return '★'.repeat(confidence) + '☆'.repeat(5 - confidence);
}
