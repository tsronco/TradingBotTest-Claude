export type AccountId = 'conservative_paper' | 'aggressive_paper' | 'manual_paper' | 'live';
export type AssetClass = 'stock' | 'option';
export type StockSide = 'buy' | 'sell' | 'sell_short';
export type OptionSide = 'BTO' | 'STO' | 'BTC' | 'STC';
export type OrderSide = StockSide | OptionSide;
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing';
export type Tif = 'day' | 'gtc';
export type ContractType = 'put' | 'call';
export type ClosedBy = null | 'manual' | 'expired' | 'assigned' | 'canceled';

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

export type RuleSeverity = 'info' | 'warn';
export interface RuleWarning {
  rule: 'sizing_1x' | 'earnings_within_7d' | 'bot_wheel_overlap';
  severity: RuleSeverity;
  message: string;
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
