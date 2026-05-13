// dashboard/api/_lib/rules-types.ts
//
// Central type module for the rules / playbook / coaching system.
// Imported by: the rules API, the pre-order rule checker, the tendency-
// detection cron, the assignment auto-spawn cron, and the rules UI hooks.

export const TRIGGER_TYPES = [
  'symbol_in', 'symbol_not_in', 'side', 'asset_class',
  'option_type', 'option_dte_lt', 'option_dte_gt',
  'open_position_count_gt', 'earnings_within_days',
  'strike_below_cost_basis', 'tag_present',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type Trigger =
  | { type: 'symbol_in'; symbols: string[] }
  | { type: 'symbol_not_in'; symbols: string[] }
  | { type: 'side'; value: 'buy' | 'sell' }
  | { type: 'asset_class'; value: 'stock' | 'option' }
  | { type: 'option_type'; value: 'put' | 'call' }
  | { type: 'option_dte_lt'; value: number }
  | { type: 'option_dte_gt'; value: number }
  | { type: 'open_position_count_gt'; value: number }
  | { type: 'earnings_within_days'; value: number }
  | { type: 'strike_below_cost_basis' }
  | { type: 'tag_present'; tag: string };

/**
 * Runtime validator for Trigger payloads coming from the wire (e.g., POST
 * body to /api/rules/manual). Returns true when the value matches a Trigger
 * variant, false otherwise. Does NOT mutate.
 */
export function isTrigger(x: unknown): x is Trigger {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.type !== 'string') return false;
  if (!(TRIGGER_TYPES as readonly string[]).includes(o.type)) return false;
  switch (o.type) {
    case 'symbol_in':
    case 'symbol_not_in':
      return Array.isArray(o.symbols) && o.symbols.every((s) => typeof s === 'string');
    case 'side':
      return o.value === 'buy' || o.value === 'sell';
    case 'asset_class':
      return o.value === 'stock' || o.value === 'option';
    case 'option_type':
      return o.value === 'put' || o.value === 'call';
    case 'option_dte_lt':
    case 'option_dte_gt':
    case 'open_position_count_gt':
    case 'earnings_within_days':
      return typeof o.value === 'number';
    case 'strike_below_cost_basis':
      return true;
    case 'tag_present':
      return typeof o.tag === 'string';
    default:
      return false;
  }
}

export type Severity = 'block' | 'warn';

export interface ManualRule {
  id: string;
  title: string;
  body: string;                       // markdown, plain English — read by AI grader
  severity: Severity;
  triggers: Trigger[];                // ALL must match for rule to fire
  source: 'manual' | 'tendency';      // 'tendency' if promoted from a proposal
  created_at: string;
  updated_at: string;
}

export interface Pattern {
  id: string;
  name: string;
  environment: string;
  variables: string[];
  legs: string[];
  rules: string[];
  win_rate?: number;
  created_at: string;
  updated_at: string;
}

export interface Cheatsheet {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Goal {
  id: string;
  body: string;
  target?: string;
  due?: string;
  checked?: boolean;
  created_at: string;
  updated_at: string;
}

export const MATCHER_NAMES = [
  'loss_concentration_by_symbol',
  'loss_concentration_by_side',
  'cc_below_cost_basis',
  'held_through_earnings',
  'override_loss_pattern',
  'over_grading_self',
] as const;
export type MatcherName = (typeof MATCHER_NAMES)[number];

export interface Tendency {
  id: string;
  matcher: MatcherName;
  finding: string;                    // plain-English finding text
  evidence_trade_ids: string[];
  detected_at: string;
}

export interface Proposal {
  id: string;
  matcher: MatcherName;
  proposed_rule: {
    title: string;
    body: string;
    severity: Severity;
    triggers: Trigger[];
  };
  reasoning: string;                  // why this rule (from Sonnet)
  evidence_trade_ids: string[];
  status: 'open' | 'dismissed' | 'approved';
  proposed_at: string;
  resolved_at?: string;
  /** When set, this proposal demotes an existing rule (severity → 'warn') instead of creating a new one. */
  demote_target_rule_id?: string;
}

/**
 * One per mode (cons/agg/manual). Pushed by the bot side from config.MODES
 * after each monitor run. Stored at KV key `bot:rules:${mode}` (3 keys total).
 */
export interface BotRulesPayload {
  mode: 'conservative' | 'aggressive' | 'manual';
  wheel: {
    symbols: string[];
    priority_tier?: string[];         // aggressive only
    fallback_tier?: string[];         // aggressive only
    otm_pct: number;
    dte_min: number;
    dte_max: number;
    close_at_profit_pct: number;
  };
  strategy: {
    underlying: string;
    initial_qty: number;
    stop_loss_pct: number;
    trail_activate_pct: number;
    trail_floor_pct: number;
    ladders: { trigger_pct: number; qty: number }[];
  };
  congress?: {                        // conservative only
    /**
     * One entry per disclosure-amount sizing tier, matching congress-copy/config.py SIZING_TIERS.
     * The largest tier's `max_disclosure_usd` is the sentinel `1e18` to represent "unbounded"
     * (the source uses `Decimal('Infinity')`, which has no JSON representation). UI should
     * detect this sentinel and render as "no cap" or similar rather than displaying $1e18.
     */
    sizing_tiers: { max_disclosure_usd: number; alloc_usd: number }[];
    politicians: { slug: string; name: string }[];
  };
  /** Optional flags surfaced by manual mode (e.g., wheel_skip_new_puts, auto_discover_symbols). */
  flags?: Record<string, boolean>;
  pushed_at: string;
}

/**
 * Inbox entry for STO put assignments awaiting follow-on stock trade spawn.
 * `account` is the full AccountId union — assignments on the live account
 * stay on live so the bot manages the resulting shares with the same Stage 2
 * covered-call flow as paper.
 */
export interface AssignmentEntry {
  parent_trade_id: string;
  underlying: string;
  strike: number;
  qty: number;
  account: 'conservative_paper' | 'aggressive_paper' | 'manual_paper' | 'live';
  detected_at: string;
}

/**
 * Stable, prefixed ID generator. Time + random component (8 chars base36)
 * so concurrent cron + UI submissions are extremely unlikely to collide.
 */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${ts}-${rand}`;
}
