// Accounts: manual (paper) + live (real money) + agent_paper — the autonomous
// Claude-driven account (agentic trading), registered 2026-08-18. The
// conservative/aggressive/sm* accounts were retired 2026-06-29.
export type AccountId = 'manual_paper' | 'live' | 'agent_paper';

// AI hindsight grading covers the two hand-traded accounts — manual + live —
// where the user picks an entry grade the AI can be calibrated against.
//
// `agent_paper` is deliberately NOT gradeable here: that account's trades are
// opened by Claude with a falsifiable thesis and are already graded in-loop by
// agent_grading.py (process grade vs outcome grade, anticipated-vs-blind_spot
// loss classification), and there is no human entry grade to calibrate against.
// Running the dashboard's grader over them would duplicate the work and pollute
// the calibration stats. Those lessons surface on /agent instead.
//
// Single source of truth for every grading gate (cron close-loop, needs-grade
// drain, regrade endpoint) and the client button visibility.
export const GRADEABLE_ACCOUNTS: ReadonlySet<AccountId> = new Set<AccountId>([
  'manual_paper', 'live',
]);

// Accepts a plain string so client callers (where the selected account is
// `string | undefined`) don't need a cast — an unknown string is simply not in
// the set.
export function isGradeable(account: string): boolean {
  return (GRADEABLE_ACCOUNTS as ReadonlySet<string>).has(account);
}

export type AssetClass = 'stock' | 'option' | 'spread';
export type StockSide = 'buy' | 'sell' | 'sell_short';
export type OptionSide = 'BTO' | 'STO' | 'BTC' | 'STC';
export type OrderSide = StockSide | OptionSide;
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing';
export type Tif = 'day' | 'gtc';
export type ContractType = 'put' | 'call';
export type ClosedBy = null | 'manual' | 'expired' | 'assigned' | 'canceled' | 'bot_external';

export type GradeLetter =
  | 'A+' | 'A' | 'A-'
  | 'B+' | 'B' | 'B-'
  | 'C+' | 'C' | 'C-'
  | 'D' | 'F';

export type Calibration = 'matched' | 'over_1' | 'over_2' | 'under_1' | 'under_2';

export interface GreeksAtEntry {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export type RuleSeverity = 'info' | 'warn' | 'block';
export interface RuleWarning {
  rule: string;                       // built-in IDs OR user-defined rule.id
  severity: RuleSeverity;
  message: string;
  // Required at runtime iff severity === 'block' — captures the user's
  // justification for proceeding through a hard-block rule.
  override_reason?: string;
}

/**
 * One entry per Alpaca modify (PATCH /v2/orders/{id}). Alpaca cancels the
 * old order and creates a new one with a new id; we capture each step
 * here so the trade detail page can show the full audit trail.
 *
 * `source: 'dashboard'` means the user modified through our order form
 * (live capture). `source: 'backfill'` means we reconstructed the event
 * from the `replaces` chain on Alpaca after the fact (e.g., when the
 * trade was modified directly on the Alpaca web UI before our cron
 * caught up).
 */
export interface ModifyEvent {
  ts: string;
  prev_order_id: string;
  new_order_id: string;
  qty?: number;
  limit_price?: number | null;
  stop_price?: number | null;
  source: 'dashboard' | 'backfill';
}

export interface SpreadLeg {
  occ: string;
  strike: number;
  entry_premium: number | null;   // null until fill
  fill_price: number | null;      // null until fill; populated by syncFillData
  qty: number;
  // Alpaca order id for this leg, captured by syncFillData from the nested
  // mleg order (or the FILL activity fallback). Lets the importer dedup a
  // dashboard-placed spread against the Alpaca activity log. Undefined on
  // legacy records and until the first successful fill sync.
  order_id?: string;
}

export type SpreadType = 'put_credit' | 'put_debit' | 'call_credit' | 'call_debit';

export interface SpreadDetails {
  spread_type: SpreadType;
  short_leg: SpreadLeg;           // leg you sold (STO)
  long_leg: SpreadLeg;            // leg you bought (BTO)
  expiration: string;             // ISO date "2026-05-29"
  width: number;                  // |short_strike - long_strike|
  // For credit spreads (put_credit, call_credit): net_credit set, net_debit
  // is 0; max_loss = width - net_credit, max_profit = net_credit.
  // For debit spreads (put_debit, call_debit): net_debit set, net_credit
  // is 0; max_loss = net_debit, max_profit = width - net_debit.
  net_credit: number;             // updated from order target to actual on fill
  net_debit?: number;             // present on debit spreads
  max_loss: number;               // collateral / worst-case dollar loss per spread (× 100)
  max_profit?: number;            // best-case dollar profit per spread (× 100); optional for backward-compat on legacy records
}

/** Which option type a vertical is built from. The spread type is the
 *  authority — a record's `contract_type` can be wrong on legacy rows written
 *  before the importer handled anything but put credit spreads. */
export function optionTypeForSpread(spreadType: SpreadType): ContractType {
  return spreadType === 'put_credit' || spreadType === 'put_debit' ? 'put' : 'call';
}

/** True for the two credit structures (money in at open). */
export function isCreditSpread(spreadType: SpreadType): boolean {
  return spreadType === 'put_credit' || spreadType === 'call_credit';
}

/**
 * Classify a two-leg vertical from its structure, and derive its P&L bounds.
 *
 * The structure — not the sign of the fill — decides the type. Which leg you
 * sold relative to the other determines whether the spread is a credit or a
 * debit, and that holds even if a bad fill makes the net come out the "wrong"
 * way:
 *
 *   put,  short strike ABOVE long   → put_credit   (bull put)
 *   put,  short strike BELOW long   → put_debit    (bear put)
 *   call, short strike BELOW long   → call_credit  (bear call)
 *   call, short strike ABOVE long   → call_debit   (bull call)
 *
 * Premiums are per share. `net` is short − long: positive on a credit spread
 * (money in), negative on a debit spread (money out).
 */
export function classifyVertical(input: {
  optionType: ContractType;
  shortStrike: number;
  longStrike: number;
  shortPremium: number;
  longPremium: number;
}): {
  spread_type: SpreadType;
  is_credit: boolean;
  /** Opening side of the package: you sell a credit spread, buy a debit one. */
  side: 'STO' | 'BTO';
  width: number;
  net: number;
  net_credit: number;
  net_debit: number;
  max_loss: number;
  max_profit: number;
} {
  const { optionType, shortStrike, longStrike, shortPremium, longPremium } = input;
  const width = Math.abs(shortStrike - longStrike);
  const net = shortPremium - longPremium;
  const shortIsHigher = shortStrike > longStrike;

  const spread_type: SpreadType = optionType === 'put'
    ? (shortIsHigher ? 'put_credit' : 'put_debit')
    : (shortIsHigher ? 'call_debit' : 'call_credit');

  const is_credit = spread_type === 'put_credit' || spread_type === 'call_credit';

  // Credit: you keep the net, risk the rest of the width.
  // Debit:  you pay the net, and that payment is the entire risk.
  const net_credit = is_credit ? net : 0;
  const net_debit = is_credit ? 0 : -net;
  const max_loss = is_credit ? width - net : net_debit;
  const max_profit = is_credit ? net : width - net_debit;

  return {
    spread_type,
    is_credit,
    side: is_credit ? 'STO' : 'BTO',
    width,
    net,
    net_credit,
    net_debit,
    max_loss,
    max_profit,
  };
}

export interface Trade {
  id: string;
  account: AccountId;
  asset_class: AssetClass;
  symbol: string;
  side: OrderSide;
  qty: number;
  order_type: OrderType;
  limit_price: number | null;
  stop_price: number | null;
  trail_pct: number | null;
  tif: Tif;
  contract_symbol: string | null;
  strike: number | null;
  expiration: string | null;
  contract_type: ContractType | null;
  greeks_at_entry: GreeksAtEntry | null;
  alpaca_order_id: string;
  alpaca_close_order_id: string | null;
  submitted_at: string;
  filled_at: string | null;
  filled_avg_price: number | null;
  closed_at: string | null;
  closed_avg_price: number | null;
  realized_pnl: number | null;
  closed_by: ClosedBy;
  tags: string[];
  entry_grade: GradeLetter;
  entry_reasoning: string;
  journal: string;
  exposure_at_submit: number;
  rule_warnings_at_entry: RuleWarning[];
  modify_history?: ModifyEvent[];
  schema: 1;
  parent_id?: string;
  source?: 'manual' | 'assignment';
  spread?: SpreadDetails;
  ai_grade_inherited?: boolean;
  cost_basis_at_entry?: number | null;
  earnings_during_hold?: boolean;
  /**
   * Set to true the first time syncFillData confirms a fill from Alpaca.
   * Once set, syncFillData skips the Alpaca order fetch on every subsequent
   * cron tick — the fill data is already captured and won't change.
   * Undefined on legacy trades (treat as not-yet-confirmed).
   */
  fill_confirmed?: boolean;
}

export interface GradeEntry {
  letter: GradeLetter;
  reasoning: string;
  ts: string;
}

export interface GradeHindsight {
  letter: GradeLetter;
  review: string;
  calibration: Calibration;
  tendencies_hit: string[];
  model: string;
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number };
  ts: string;
  parse_failed?: boolean;
  raw?: string;
}

export interface GradeRecord {
  trade_id: string;
  entry: GradeEntry;
  hindsight: GradeHindsight | null;
  history: Array<{ entry: GradeEntry; hindsight: GradeHindsight }>;
}

/**
 * Summary returned by `POST /api/trades/import` — backfills trade records
 * from raw Alpaca FILL activities for positions opened outside the
 * dashboard (e.g. directly on the Alpaca web UI, or by the bot before the
 * dashboard's external-close detection was wired up).
 */
export interface TradeImportSummary {
  imported: number;
  skipped_existing: number;
  spread_pairs_found: number;
  errors: string[];
  created_trade_ids: string[];
}

export const GRADE_LETTERS: GradeLetter[] = [
  'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F',
];

export function gradeIndex(letter: GradeLetter): number {
  return GRADE_LETTERS.indexOf(letter);
}

export function calibrationFor(userLetter: GradeLetter, aiLetter: GradeLetter): Calibration {
  const delta = gradeIndex(userLetter) - gradeIndex(aiLetter);
  if (delta === 0) return 'matched';
  if (delta < 0) return delta === -1 ? 'over_1' : 'over_2';
  return delta === 1 ? 'under_1' : 'under_2';
}
