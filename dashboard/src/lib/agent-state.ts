// Types + pure derivations for the autonomous agent account's state document.
//
// The agent (agent_trader.py) writes `agent_state.json` each hourly cycle and
// agent-trader.yml pushes it to KV under `bot:agent:state`. This module mirrors
// that shape for the dashboard's read-only `/agent` surface.
//
// Everything here is defensively optional: the state document is produced by a
// Python harness and graded by a separate Claude call that can legitimately
// refuse or error (a neutral ungraded record is written instead of throwing).
// The dashboard must render a partial record rather than blank the page, so no
// field below is assumed present.

export interface AgentLeg {
  asset?: 'option' | 'stock' | string;
  qty?: number;
  side?: 'buy' | 'sell' | string;
  symbol?: string;
}

export interface AgentThesis {
  /** The view: what the agent believes and why. */
  thesis?: string;
  /** The math — what it's being paid to take this risk. */
  getting_paid?: string;
  /** Single biggest risk it named at entry. */
  key_risk?: string;
  /** The falsifiable condition that would prove the thesis wrong. */
  invalidation?: string;
  /** Structures it considered and passed on. */
  rejected?: string;
  /** 1–5 self-reported confidence at entry. */
  confidence?: number;
}

/** Hindsight grade written by agent_grading.py when a position closes. */
export interface AgentGrade {
  graded?: boolean;
  /** Quality of the DECISION, independent of the result. */
  process_grade?: string;
  /** Quality of the RESULT. */
  outcome_grade?: string;
  /** 'anticipated' = lost via a risk the thesis named; 'blind_spot' = lost for
   *  a risk it never saw (the valuable lesson). */
  loss_type?: 'anticipated' | 'blind_spot' | string;
  invalidation_fired?: string;
  exit_quality?: string;
  lesson?: string;
}

export interface AgentSnapshot {
  cost_basis?: number;
  market_value?: number;
  unrealized_pl?: number;
  pnl_basis?: string;
  seen_at?: string;
  underlyings?: Record<string, number>;
}

/** Intended-vs-actual fill, per share. Negative slippage = worse than asked. */
export interface AgentFill {
  fill_available?: boolean;
  intended_net_credit?: number | null;
  actual_net_credit?: number | null;
  slippage?: number | null;
  note?: string;
}

export interface AgentPosition {
  opened_at?: string;
  legs?: AgentLeg[];
  thesis?: AgentThesis | null;
  open_order_id?: string;
  intended_net_credit?: number | null;
  fill?: AgentFill | null;
  entry_context?: { underlyings?: Record<string, number> };
  last_snapshot?: AgentSnapshot | null;
}

export interface AgentOutcome {
  days_held?: number;
  estimated_pnl?: number;
  estimated_pnl_basis?: string;
  underlying_moves?: Record<string, unknown>;
}

export interface AgentClosedTrade {
  opened_at?: string;
  closed_at?: string;
  legs?: AgentLeg[];
  thesis?: AgentThesis | null;
  outcome?: AgentOutcome | null;
  grade?: AgentGrade | null;
}

export interface AgentCycleOutcome {
  opened?: { legs?: string; order_id?: string; intended_net_credit?: number | null }[];
  closed?: { legs?: string; order_id?: string }[];
  rejected?: { legs?: string; source?: string; reason?: string }[];
}

export interface AgentMeta {
  created_at?: string;
  cycle_count?: number;
  last_cycle_at?: string;
  last_market_read?: string;
  last_cycle_outcome?: AgentCycleOutcome | null;
  seed_capital?: number;
}

export interface AgentState {
  _meta?: AgentMeta;
  positions?: Record<string, AgentPosition>;
  closed?: AgentClosedTrade[];
}

// ── Derivations ────────────────────────────────────────────────────────────

/** Open positions as an array, newest first, with the state-dict key attached. */
export function openPositions(
  state: AgentState | null | undefined,
): (AgentPosition & { id: string })[] {
  const positions = state?.positions ?? {};
  return Object.entries(positions)
    .map(([id, p]) => ({ ...p, id }))
    .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''));
}

/** Closed trades, newest close first. */
export function closedTrades(state: AgentState | null | undefined): AgentClosedTrade[] {
  return [...(state?.closed ?? [])].sort(
    (a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''),
  );
}

export interface AgentStats {
  total: number;
  wins: number;
  losses: number;
  /** Closed trades with no usable P&L number — excluded from win/loss. */
  unknown: number;
  winRate: number | null;
  totalPnl: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** avgWin / |avgLoss| — the metric that matters more than win rate alone. */
  winLossRatio: number | null;
  anticipated: number;
  blindSpot: number;
  graded: number;
}

function pnlOf(t: AgentClosedTrade): number | null {
  const v = t.outcome?.estimated_pnl;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Roll up the closed-trade record.
 *
 * A P&L of exactly 0 counts as neither a win nor a loss — it is a real,
 * scratch outcome, so it is included in `total` and `totalPnl` but not in the
 * win/loss split. Trades with no usable P&L are counted in `unknown` and left
 * out of every average, so a missing number can never masquerade as a scratch.
 */
export function agentStats(trades: AgentClosedTrade[]): AgentStats {
  let wins = 0, losses = 0, unknown = 0, totalPnl = 0;
  let winSum = 0, lossSum = 0;
  let anticipated = 0, blindSpot = 0, graded = 0;

  for (const t of trades) {
    const pnl = pnlOf(t);
    if (pnl === null) {
      unknown += 1;
    } else {
      totalPnl += pnl;
      if (pnl > 0) { wins += 1; winSum += pnl; }
      else if (pnl < 0) { losses += 1; lossSum += pnl; }
    }
    const g = t.grade;
    if (g?.graded) graded += 1;
    if (g?.loss_type === 'anticipated') anticipated += 1;
    if (g?.loss_type === 'blind_spot') blindSpot += 1;
  }

  const decided = wins + losses;
  const avgWin = wins > 0 ? winSum / wins : null;
  const avgLoss = losses > 0 ? lossSum / losses : null;

  return {
    total: trades.length,
    wins,
    losses,
    unknown,
    winRate: decided > 0 ? (wins / decided) * 100 : null,
    totalPnl,
    avgWin,
    avgLoss,
    winLossRatio:
      avgWin !== null && avgLoss !== null && avgLoss !== 0
        ? avgWin / Math.abs(avgLoss)
        : null,
    anticipated,
    blindSpot,
    graded,
  };
}

export interface ConfidenceBucket {
  confidence: number;
  trades: number;
  wins: number;
  winRate: number | null;
  totalPnl: number;
}

/**
 * Confidence calibration — do the agent's 4–5s actually beat its 1–2s?
 *
 * Buckets 1–5 are always returned (empty ones included) so the panel renders a
 * stable axis instead of reflowing as trades land. Trades with no confidence
 * or an out-of-range value are ignored.
 */
export function confidenceCalibration(trades: AgentClosedTrade[]): ConfidenceBucket[] {
  const buckets: ConfidenceBucket[] = [1, 2, 3, 4, 5].map((c) => ({
    confidence: c, trades: 0, wins: 0, winRate: null, totalPnl: 0,
  }));
  const decided: number[] = [0, 0, 0, 0, 0];

  for (const t of trades) {
    const c = t.thesis?.confidence;
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > 5) continue;
    const b = buckets[c - 1];
    b.trades += 1;
    const pnl = pnlOf(t);
    if (pnl === null) continue;
    b.totalPnl += pnl;
    if (pnl > 0) { b.wins += 1; decided[c - 1] += 1; }
    else if (pnl < 0) { decided[c - 1] += 1; }
  }

  buckets.forEach((b, i) => {
    b.winRate = decided[i] > 0 ? (b.wins / decided[i]) * 100 : null;
  });
  return buckets;
}

/** Sum of the mid-based unrealized P&L across open positions, or null if no
 *  position has been snapshotted yet (a freshly opened position has none). */
export function openUnrealizedPnl(positions: AgentPosition[]): number | null {
  const values = positions
    .map((p) => p.last_snapshot?.unrealized_pl)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
}
