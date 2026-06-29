// dashboard/api/trades/[action].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { requireAuth } from '../_lib/auth-guard.js';
import { computeExposure } from '../_lib/exposure.js';
import { runStubRuleChecks, runRuleChecks } from '../_lib/rule-check.js';
import { alpacaData, alpacaTrade, alpacaTradeMutation } from '../_lib/data-api.js';
import {
  GRADE_LETTERS,
  isGradeable,
  type GradeLetter,
  type SpreadType,
  type Trade,
  type TradeImportSummary,
} from '../_lib/trade-types.js';
import { allocateTradeId, currentMonth } from '../_lib/trade-ids.js';
import {
  KV_KEYS, tradeKey, gradeKey, tradesIndexMonthKey, assignmentChildKey, importCursorKey,
  idemKey, IDEM_INDEX_TTL_SECONDS,
  readMonthIndex, appendMonthIndex,
} from '../_lib/kv-keys.js';
import { resolveCostBasisForCc } from '../_lib/cost-basis.js';
import { verifyTotp } from '../_lib/totp.js';
import { gradeTrade } from '../_lib/grading.js';
import { etOffsetMinutes } from '../_lib/et-time.js';
import { runGradeOpenTrades } from '../cron/[job].js';

interface OrderDraft {
  account: 'manual_paper' | 'live';
  asset_class: 'stock' | 'option';
  symbol: string;
  side: string;
  qty: number;
  order_type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing';
  limit_price: number | null;
  stop_price?: number | null;
  trail_pct?: number | null;
  tif: 'day' | 'gtc';
  contract_symbol?: string | null;
  strike?: number | null;
  expiration?: string | null;
  contract_type?: 'put' | 'call' | null;
  entry_grade: string;
  entry_reasoning: string;
  tags: string[];
  totp_code?: string;
  // D2 — idempotency key. Generated once by ConfirmModal and reused on
  // every retry of the same order so that a dropped-response re-click
  // cannot double-place. If omitted, the server derives a deterministic
  // fallback from the pre-allocated trade id.
  idempotency_key?: string;
}

// Per-account TOTP re-prompt thresholds. Keep in sync with settings/[resource].ts
// DEFAULT_THRESHOLDS and api/_lib/rule-check.ts accountToMode().
const DEFAULT_THRESHOLDS = {
  manual_paper: 2500, live: 1500,
};

interface SpreadLegPayload {
  occ: string;
  strike: number;
  entry_premium: number | null;
}

interface SpreadPayload {
  kind: 'spread';
  account: OrderDraft['account'];
  symbol: string;
  spread_type: SpreadType;
  short_leg: SpreadLegPayload;    // leg the user is selling (STO)
  long_leg: SpreadLegPayload;     // leg the user is buying (BTO)
  expiration: string;
  qty: number;
  // Negative for credit spreads (you receive), positive for debit spreads (you pay).
  // The form encodes this convention; spreadMath() derives credit/debit/max_loss/max_profit.
  limit_price: number;
  tif?: 'day' | 'gtc';            // defaults to 'day' for back-compat with existing callers
  entry_grade: string;
  entry_reasoning: string;
  tags?: string[];
  totp_code?: string;
  rule_warnings_at_entry?: any[];
  // D2 — idempotency key (same as OrderDraft.idempotency_key)
  idempotency_key?: string;
}

const VALID_SPREAD_TYPES: ReadonlySet<SpreadType> = new Set<SpreadType>([
  'put_credit', 'put_debit', 'call_credit', 'call_debit',
]);

function isSpreadPayload(body: any): body is SpreadPayload {
  return body && body.kind === 'spread';
}

function isCreditSpread(t: SpreadType): boolean {
  return t === 'put_credit' || t === 'call_credit';
}

function spreadMath(p: SpreadPayload) {
  const width = Math.abs(p.short_leg.strike - p.long_leg.strike);
  // limit_price convention: negative = credit (you receive), positive = debit (you pay).
  // Trust the form's sign rather than re-deriving from spread_type so that a
  // call-debit form sending +1.20 and a put-credit form sending -0.10 both
  // route through one math path.
  if (p.limit_price <= 0) {
    const net_credit = Math.abs(p.limit_price);
    return {
      width,
      net_credit,
      net_debit: 0,
      max_loss: width - net_credit,
      max_profit: net_credit,
    };
  }
  const net_debit = p.limit_price;
  return {
    width,
    net_credit: 0,
    net_debit,
    max_loss: net_debit,
    max_profit: width - net_debit,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  const action = String(req.query.action ?? '');

  if (req.method === 'POST' && action === 'preview') return preview(req, res);
  if (req.method === 'POST' && action === 'submit') return submit(req, res);
  if (req.method === 'POST' && action === 'check') return check(req, res);
  if (req.method === 'GET' && action === 'list') return list(req, res);
  if (req.method === 'GET' && action === 'get') return getOne(req, res);
  if (req.method === 'GET' && action === 'calendar') return calendar(req, res);
  if (req.method === 'GET' && action === 'performance') return performance(req, res);
  if (req.method === 'POST' && action === 'regrade') return regrade(req, res);
  if (req.method === 'POST' && action === 'update') return updateTrade(req, res);
  if (req.method === 'POST' && action === 'import') return importFromAlpaca(req, res);
  if (req.method === 'POST' && action === 'refresh') return refresh(req, res);
  if (req.method === 'POST' && action === 'delete') return deleteTrade(req, res);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

/**
 * Permanently delete a trade record and scrub it from every index it can
 * appear in. Intended for cleaning up duplicates / bad imports (e.g. a
 * dashboard-placed spread that the auto-importer re-created as a second
 * record). This removes the trade from P&L, win-rate, and calibration
 * aggregates. Idempotent on the indexes (lrem/filter are no-ops if absent).
 *
 * The month index key is derived from the trade id (T-YYYY-MM-DD-NNN), so a
 * missing trade record doesn't block the cleanup.
 */
async function deleteTrade(req: VercelRequest, res: VercelResponse) {
  const id = String((req.body as any)?.id ?? req.query.id ?? '');
  if (!/^T-\d{4}-\d{2}-\d{2}-\d+$/.test(id)) return res.status(400).json({ error: 'invalid_trade_id' });

  const trade = await kv().get<Trade>(tradeKey(id));
  if (!trade) return res.status(404).json({ error: 'trade_not_found' });

  const month = id.slice(2, 9); // "T-2026-06-17-030" → "2026-06"

  // Remove from the open index and this month's index (Redis lists).
  await kv().lrem(KV_KEYS.tradesIndexOpen, 0, id);
  await kv().lrem(tradesIndexMonthKey(month), 0, id);

  // Remove from the needs-grade queue (JSON-array backed).
  const nq = (await kv().get<string[]>(KV_KEYS.tradesIndexNeedsGrade)) ?? [];
  if (nq.includes(id)) {
    await kv().set(KV_KEYS.tradesIndexNeedsGrade, nq.filter((x) => x !== id));
  }

  // Drop the trade + grade records.
  await kv().del(tradeKey(id));
  await kv().del(gradeKey(id));

  return res.status(200).json({ ok: true, deleted: id });
}

/**
 * On-demand sync — runs the same logic as the grade-open-trades cron from
 * a dashboard button click. Idempotent (no-op on already-synced trades).
 *
 * Used when the user knows something happened on Alpaca (bot closed a
 * position, manual close on Alpaca's web UI, just imported some trades)
 * and doesn't want to wait for the next 5-min cron tick. Returns the
 * same shape as the cron handler so the UI can show a "synced N · closed
 * N · graded N" summary inline.
 *
 * Throttle is enforced client-side (button disables for 15s). No server
 * throttle because the underlying loop is idempotent and capped at
 * MAX_PER_TICK trades per call — repeat clicks just no-op.
 */
async function refresh(req: VercelRequest, res: VercelResponse) {
  // Drain mode (?mode=drain): for clearing a large backlog in one click. Lifts
  // the per-tick sweep cap and keeps fill-syncing + close-detecting until a
  // soft wall-clock budget (well under the 60s function limit) is hit, so it
  // never 504s. AI grading is deferred entirely to the needs-grade queue
  // (gradeBudget 0) so closes land fast; the cron fills in hindsight grades
  // on later ticks. A follow-up drain click resumes from the rotating cursor.
  const mode = String(req.query?.mode ?? '');
  const drain = mode === 'drain';
  // Grade mode (?mode=grade): the "grade backlog" button. Run AI grading on the
  // needs-grade queue now — big grade budget, 45s cap — scoped to the account.
  // Unlike drain it does NOT lift the sweep cap; the point is to grade, not to
  // re-walk every open trade.
  const grade = mode === 'grade';
  // Optional account scope: a /trades refresh of a single account passes the
  // page's selected account so the sweep + the "N still open" count cover only
  // that account. Absent (the [any] filter, or the scheduled cron) → global.
  const account = req.query?.account ? String(req.query.account) : undefined;
  const opts: { sweepBudget?: number; gradeBudget?: number; timeBudgetMs?: number; account?: string } = {};
  if (drain) { opts.sweepBudget = Number.MAX_SAFE_INTEGER; opts.gradeBudget = 0; opts.timeBudgetMs = 45_000; }
  if (grade) { opts.gradeBudget = Number.MAX_SAFE_INTEGER; opts.timeBudgetMs = 45_000; }
  if (account) opts.account = account;
  try {
    // Preserve the no-arg call when neither drain nor account is set so the
    // scheduled-cron call path stays byte-identical.
    const result = Object.keys(opts).length
      ? await runGradeOpenTrades(opts)
      : await runGradeOpenTrades();
    return res.status(200).json({ ok: true, drain, ...result });
  } catch (e) {
    console.error('[refresh] runGradeOpenTrades failed', e);
    return res.status(500).json({
      error: 'refresh_failed',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

function validate(draft: OrderDraft): string[] {
  const errs: string[] = [];
  if (!draft.symbol) errs.push('symbol_required');
  if (!Number.isFinite(draft.qty) || draft.qty <= 0) errs.push('qty_invalid');
  if (!draft.entry_reasoning?.trim()) errs.push('entry_reasoning_required');
  if (!GRADE_LETTERS.includes(draft.entry_grade as GradeLetter)) errs.push('entry_grade_invalid');
  if (draft.order_type === 'limit' && !Number.isFinite(draft.limit_price)) errs.push('limit_price_required');
  if (draft.order_type === 'stop' && !Number.isFinite(draft.stop_price ?? NaN)) errs.push('stop_price_required');
  if (draft.order_type === 'stop_limit'
      && (!Number.isFinite(draft.stop_price ?? NaN) || !Number.isFinite(draft.limit_price ?? NaN))) {
    errs.push('stop_limit_prices_required');
  }
  if (draft.order_type === 'trailing' && !Number.isFinite(draft.trail_pct ?? NaN)) {
    errs.push('trail_pct_required');
  }
  return errs;
}

async function getQuote(symbol: string, asset_class: 'stock' | 'option', mode: string) {
  if (asset_class === 'stock') {
    const snap = await alpacaData<any>(mode as any, '/v2/stocks/snapshots', { symbols: symbol });
    const q = snap?.[symbol]?.latestQuote ?? snap?.snapshots?.[symbol]?.latestQuote;
    return { ask: q?.ap ?? 0, bid: q?.bp ?? 0 };
  }
  const snap = await alpacaData<any>(mode as any, '/v1beta1/options/snapshots', { symbols: symbol });
  const q = snap?.snapshots?.[symbol]?.latestQuote;
  return { ask: q?.ap ?? 0, bid: q?.bp ?? 0 };
}

// Current price of an UNDERLYING stock (mid of the latest quote), used to
// evaluate OTM-distance rules. Returns null when no usable quote is available
// so the rule simply doesn't fire rather than mis-firing on bad data.
async function getUnderlyingPrice(symbol: string, mode: string): Promise<number | null> {
  try {
    const { ask, bid } = await getQuote(symbol, 'stock', mode);
    const mid = ask > 0 && bid > 0 ? (ask + bid) / 2 : (ask || bid || 0);
    return mid > 0 ? mid : null;
  } catch {
    return null;
  }
}

// Account → bot mode. MUST match api/_lib/rule-check.ts accountToMode() and the
// duplicate copy in cron/[job].ts modeFromAccount() exactly — live routes to the
// live Alpaca credentials, NOT manual's. (DRY follow-up: these three copies live
// across the api/ vs src/ build-root boundary; keep in sync.)
function modeFromAccount(account: string): string {
  if (account === 'live') return 'live';
  return 'manual';
}

async function check(req: VercelRequest, res: VercelResponse) {
  const draft = (req.body ?? {}) as Partial<OrderDraft> & {
    option_type?: 'put' | 'call';
    strike?: number | null;
    expiration?: string | null;
    tags?: string[];
  };

  const account = (draft.account ?? 'manual_paper') as OrderDraft['account'];
  const mode = modeFromAccount(account);

  let positions: Array<{ symbol: string; qty: number; avg_entry_price: number }> = [];
  try {
    const raw = await alpacaTrade<Array<{ symbol: string; qty: string; avg_entry_price: string }>>(
      mode as any,
      '/v2/positions',
    );
    positions = (raw ?? []).map((p) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avg_entry_price: parseFloat(p.avg_entry_price),
    }));
  } catch {
    positions = [];
  }

  const assetClass = (draft.asset_class as 'stock' | 'option' | 'spread') ?? 'stock';
  const underlying_price = assetClass === 'stock'
    ? null
    : await getUnderlyingPrice(String(draft.symbol ?? ''), mode);

  const violations = await runRuleChecks(
    {
      asset_class: assetClass,
      symbol: String(draft.symbol ?? ''),
      qty: Number(draft.qty ?? 0),
      account,
      side: draft.side as any,
      option_type: draft.option_type,
      strike: draft.strike ?? null,
      expiration: draft.expiration ?? null,
      tags: Array.isArray(draft.tags) ? draft.tags : undefined,
      spread_type: (draft as any).spread_type,
      underlying_price,
    },
    { positions },
  );

  return res.status(200).json({ violations });
}

async function preview(req: VercelRequest, res: VercelResponse) {
  if (isSpreadPayload(req.body)) return previewSpread(req, res);
  const draft = (req.body ?? {}) as OrderDraft;
  const validation_errors = validate(draft);

  const thresholds = (await kv().get<typeof DEFAULT_THRESHOLDS>(KV_KEYS.totpThresholds)) ?? DEFAULT_THRESHOLDS;

  let exposure = 0;
  let requires_totp = false;
  let rule_warnings: any[] = [];

  if (validation_errors.length === 0) {
    const symbolForQuote = draft.asset_class === 'option' ? (draft.contract_symbol ?? draft.symbol) : draft.symbol;
    const { ask, bid } = await getQuote(symbolForQuote, draft.asset_class, modeFromAccount(draft.account));
    exposure = computeExposure({
      asset_class: draft.asset_class,
      side: draft.side as any,
      qty: draft.qty,
      order_type: draft.order_type,
      limit_price: draft.limit_price,
      contract_type: draft.contract_type ?? null,
      strike: draft.strike ?? null,
      ask, bid,
    });
    const threshold = thresholds[draft.account] ?? Number.POSITIVE_INFINITY;
    requires_totp = exposure >= threshold;
    if (draft.asset_class === 'option') {
      // Options need the full context (side/strike/type + underlying price) so
      // the OTM nudge and option-aware rules surface on the confirm modal, the
      // same set submit() re-checks server-side.
      const underlying_price = await getUnderlyingPrice(draft.symbol, modeFromAccount(draft.account));
      rule_warnings = await runStubRuleChecks({
        asset_class: 'option', symbol: draft.symbol,
        qty: draft.qty, account: draft.account,
        side: draft.side as any,
        option_type: draft.contract_type ?? undefined,
        strike: draft.strike ?? null,
        expiration: draft.expiration ?? null,
        tags: Array.isArray(draft.tags) ? draft.tags : undefined,
        underlying_price,
      });
    } else {
      rule_warnings = await runStubRuleChecks({
        asset_class: draft.asset_class, symbol: draft.symbol,
        qty: draft.qty, account: draft.account,
      });
    }
  }

  return res.status(200).json({ exposure, requires_totp, rule_warnings, validation_errors });
}

async function previewSpread(req: VercelRequest, res: VercelResponse) {
  const p = req.body as SpreadPayload;
  if (!VALID_SPREAD_TYPES.has(p.spread_type)) {
    return res.status(400).json({ error: 'invalid_spread_type', got: p.spread_type });
  }
  const { width, net_credit, max_loss } = spreadMath(p);
  const thresholds = (await kv().get<typeof DEFAULT_THRESHOLDS>(KV_KEYS.totpThresholds)) ?? DEFAULT_THRESHOLDS;

  const exposure = computeExposure({
    asset_class: 'spread',
    side: 'STO',
    qty: p.qty,
    order_type: 'limit',
    limit_price: p.limit_price,
    spread: { width, net_credit, max_loss },
  });
  const threshold = thresholds[p.account] ?? Number.POSITIVE_INFINITY;
  const requires_totp = exposure >= threshold;
  const underlying_price = await getUnderlyingPrice(p.symbol, modeFromAccount(p.account));
  const rule_warnings = await runStubRuleChecks({
    asset_class: 'spread',
    symbol: p.symbol,
    qty: p.qty,
    account: p.account,
    expiration: p.expiration,
    spread: { width, net_credit, max_loss },
    spread_type: p.spread_type,
    strike: p.short_leg.strike,
    option_type: p.spread_type === 'put_credit' || p.spread_type === 'put_debit' ? 'put' : 'call',
    underlying_price,
  });
  return res.status(200).json({
    exposure,
    requires_totp,
    rule_warnings,
    validation_errors: [],
    draft: p,
  });
}

async function submitSpread(req: VercelRequest, res: VercelResponse) {
  const p = req.body as SpreadPayload;
  if (p.account === 'live' && process.env.LIVE_ENABLED !== 'true') {
    return res.status(403).json({ error: 'live_trading_disabled' });
  }
  if (!VALID_SPREAD_TYPES.has(p.spread_type)) {
    return res.status(400).json({ error: 'invalid_spread_type', got: p.spread_type });
  }

  const { width, net_credit, net_debit, max_loss, max_profit } = spreadMath(p);
  const thresholds = (await kv().get<typeof DEFAULT_THRESHOLDS>(KV_KEYS.totpThresholds)) ?? DEFAULT_THRESHOLDS;
  const exposure = computeExposure({
    asset_class: 'spread',
    side: 'STO',
    qty: p.qty,
    order_type: 'limit',
    limit_price: p.limit_price,
    spread: { width, net_credit, max_loss },
  });
  const threshold = thresholds[p.account] ?? Number.POSITIVE_INFINITY;
  if (exposure >= threshold) {
    if (!p.totp_code || !verifyTotp(p.totp_code, process.env.TOTP_SECRET ?? '')) {
      return res.status(401).json({ error: 'invalid_totp' });
    }
  }

  // Re-run rule checks server-side
  let positions: Array<{ symbol: string; qty: number; avg_entry_price: number }> = [];
  try {
    const raw = await alpacaTrade<Array<{ symbol: string; qty: string; avg_entry_price: string }>>(
      modeFromAccount(p.account) as any,
      '/v2/positions',
    );
    positions = (raw ?? []).map((pos) => ({
      symbol: pos.symbol,
      qty: parseFloat(pos.qty),
      avg_entry_price: parseFloat(pos.avg_entry_price),
    }));
  } catch {
    positions = [];
  }
  const underlying_price = await getUnderlyingPrice(p.symbol, modeFromAccount(p.account));
  const rule_warnings = await runRuleChecks(
    {
      asset_class: 'spread',
      symbol: p.symbol,
      qty: p.qty,
      account: p.account,
      expiration: p.expiration,
      tags: Array.isArray(p.tags) ? p.tags : undefined,
      spread: { width, net_credit, max_loss },
      spread_type: p.spread_type,
      strike: p.short_leg.strike,
      option_type: p.spread_type === 'put_credit' || p.spread_type === 'put_debit' ? 'put' : 'call',
      underlying_price,
    },
    { positions },
  );

  const submittedOverrides = (req.body as any)?.rule_violations as
    | Array<{ rule: string; severity?: string; override_reason?: string }>
    | undefined;
  const overrideByRule = new Map<string, string>();
  for (const v of submittedOverrides ?? []) {
    if (typeof v?.rule === 'string' && typeof v?.override_reason === 'string') {
      overrideByRule.set(v.rule, v.override_reason);
    }
  }
  for (const v of rule_warnings) {
    if (v.severity === 'block') {
      const reason = (overrideByRule.get(v.rule) ?? '').trim();
      if (reason.length < 20) {
        return res.status(400).json({
          error: 'block_severity_requires_override_reason',
          rule: v.rule,
          rule_message: v.message,
        });
      }
      (v as any).override_reason = reason;
    }
  }

  // D2 — KV idempotency index: same cross-request dedup as stock/option submit.
  // See claimIdemIndex() for the full race-safety analysis.
  const idemClaim = await claimIdemIndex(p.idempotency_key);
  if (!idemClaim.winner) {
    const { id: origId, trade: origTrade } = idemClaim as ExistingClaim;
    return res.status(200).json({ id: origId, trade_id: origId, alpaca_order_id: origTrade.alpaca_order_id });
  }
  const id = idemClaim.id;
  const clientOrderId = (p.idempotency_key?.trim() ?? '') || `dash-${id}`;

  // Build the mleg order. Alpaca's multi-leg order endpoint expects
  // order_class:'mleg' with a `legs` array carrying side + position_intent
  // per leg. The top-level `limit_price` is the net debit/credit (negative
  // for credit spreads, which is what the form sends).
  const alpacaBody = {
    order_class: 'mleg',
    qty: String(p.qty),
    type: 'limit',
    limit_price: String(p.limit_price),
    time_in_force: p.tif ?? 'day',
    client_order_id: clientOrderId,
    legs: [
      { symbol: p.short_leg.occ, side: 'sell', ratio_qty: '1', position_intent: 'sell_to_open' },
      { symbol: p.long_leg.occ,  side: 'buy',  ratio_qty: '1', position_intent: 'buy_to_open'  },
    ],
  };
  let alpacaOrder: any;
  try {
    alpacaOrder = await alpacaTradeMutation<any>(
      modeFromAccount(p.account) as any,
      '/v2/orders',
      { method: 'POST', body: alpacaBody },
    );
  } catch (err) {
    // D2 — duplicate client_order_id: resolve the already-created order
    if (isDuplicateClientOrderIdError(err)) {
      const existing = await getOrderByClientOrderId(modeFromAccount(p.account), clientOrderId);
      if (existing?.id) {
        alpacaOrder = existing;
      } else {
        return res.status(502).json({
          error: 'alpaca_order_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      return res.status(502).json({
        error: 'alpaca_order_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const now = new Date();
  const trade: Trade = {
    id,
    account: p.account,
    asset_class: 'spread',
    symbol: p.symbol,
    side: 'STO',
    qty: p.qty,
    order_type: 'limit',
    limit_price: p.limit_price,
    stop_price: null,
    trail_pct: null,
    tif: p.tif ?? 'day',
    contract_symbol: p.short_leg.occ,
    strike: p.short_leg.strike,
    expiration: p.expiration,
    contract_type: p.spread_type === 'put_credit' || p.spread_type === 'put_debit' ? 'put' : 'call',
    greeks_at_entry: null,
    alpaca_order_id: alpacaOrder.id,
    alpaca_close_order_id: null,
    submitted_at: alpacaOrder.submitted_at ?? now.toISOString(),
    filled_at: null,
    filled_avg_price: null,
    closed_at: null,
    closed_avg_price: null,
    realized_pnl: null,
    closed_by: null,
    tags: p.tags ?? [],
    entry_grade: p.entry_grade as GradeLetter,
    entry_reasoning: p.entry_reasoning,
    journal: '',
    exposure_at_submit: exposure,
    rule_warnings_at_entry: rule_warnings,
    modify_history: [],
    schema: 1,
    spread: {
      spread_type: p.spread_type,
      short_leg: {
        occ: p.short_leg.occ,
        strike: p.short_leg.strike,
        entry_premium: p.short_leg.entry_premium,
        fill_price: null,
        qty: p.qty,
      },
      long_leg: {
        occ: p.long_leg.occ,
        strike: p.long_leg.strike,
        entry_premium: p.long_leg.entry_premium,
        fill_price: null,
        qty: p.qty,
      },
      expiration: p.expiration,
      width,
      net_credit,
      net_debit: net_debit > 0 ? net_debit : undefined,
      max_loss,
      max_profit,
    },
  };

  await kv().set(tradeKey(id), trade);
  await kv().set(gradeKey(id), {
    trade_id: id,
    entry: { letter: trade.entry_grade, reasoning: trade.entry_reasoning, ts: now.toISOString() },
    hindsight: null,
    history: [],
  });
  await kv().rpush(KV_KEYS.tradesIndexOpen, id);
  await appendMonthIndex(currentMonth(now), id);

  return res.status(200).json({ id, trade_id: id, alpaca_order_id: alpacaOrder.id });
}

/**
 * D2 — duplicate-id resolution (mirrors the Python bot's R1 pattern).
 *
 * When Alpaca rejects a POST /v2/orders with 422 because client_order_id
 * already exists, fetch the already-created order by that id instead of
 * surfacing an error. This turns a dropped-response retry into a harmless
 * no-op (the caller gets the same order back, allocates ONE trade record).
 *
 * Returns the existing order on success, or null if the lookup fails
 * (so the original error can propagate — we never silently swallow a
 * genuine Alpaca error that isn't a duplicate-id rejection).
 */
async function getOrderByClientOrderId(
  mode: string,
  clientOrderId: string,
): Promise<any> {
  try {
    return await alpacaTrade<any>(mode as any, '/v2/orders:by_client_order_id', {
      client_order_id: clientOrderId,
    });
  } catch {
    return null;
  }
}

/**
 * True when an Alpaca error looks like a duplicate client_order_id rejection
 * (422 with the id in the error text). Mirrors the Python bot's detection
 * heuristic from api_post().
 */
function isDuplicateClientOrderIdError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('422') && msg.toLowerCase().includes('client_order_id');
}

/**
 * D2 — KV idempotency index: cross-request order dedup.
 *
 * Called BEFORE allocateTradeId() in both submit and submitSpread.
 *
 * Strategy (race-safe via nx):
 *   1. Check kvGet(idemKey) — fast path if a prior request already settled.
 *   2. allocateTradeId() to reserve a fresh id.
 *   3. kv().set(idemKey, id, { nx: true, ex: TTL }) — atomic claim.
 *      - 'OK'  → this request won; proceed to Alpaca with `id`.
 *      - null  → another request won; kvGet(idemKey) returns the winner's id.
 *        Load that trade record and return it immediately (no Alpaca call).
 *
 * Returns:
 *   { winner: true, id }            — this request won the claim; use `id`
 *   { winner: false, trade, id }    — another request already succeeded;
 *                                     return `trade` to the caller verbatim
 *
 * If idempotencyKey is absent (dash-<id> fallback path), returns winner:true
 * with a freshly allocated id — no index is written because the fallback key
 * changes on every request and cannot provide cross-request dedup.
 */
type IdemClaim =
  | { winner: true; id: string }
  | { winner: false; id: string; trade: Trade };
// @vercel/node type-checks api/ with default (non-strict) options, where
// `if (!idemClaim.winner)` does NOT narrow this union — so name the loser
// branch and assert it explicitly at the two call sites below. (Local
// `tsc -b` never sees api/, so this only shows up on Vercel builds.)
type ExistingClaim = Extract<IdemClaim, { winner: false }>;

async function claimIdemIndex(
  idempotencyKey: string | undefined,
): Promise<IdemClaim> {
  const rawKey = idempotencyKey?.trim() ?? '';

  // No stable key supplied — allocate an id and skip the index entirely.
  if (!rawKey) {
    const id = await allocateTradeId();
    return { winner: true, id };
  }

  const kk = idemKey(rawKey);

  // Fast path: a prior request has already settled and written the index.
  const existing = await kv().get<string>(kk);
  if (existing) {
    const trade = await kv().get<Trade>(tradeKey(existing));
    if (trade) {
      return { winner: false, id: existing, trade };
    }
    // Index entry exists but trade record is gone (shouldn't happen in
    // practice). Fall through and let this request win.
  }

  // Allocate a trade id, then atomically claim the index entry.
  const id = await allocateTradeId();
  const claimed = await kv().set(kk, id, { nx: true, ex: IDEM_INDEX_TTL_SECONDS });

  if (claimed !== null) {
    // 'OK' — this request won the claim.
    return { winner: true, id };
  }

  // null — lost the race to another concurrent request. Read the winner's id.
  const winnerId = await kv().get<string>(kk);
  if (winnerId) {
    const trade = await kv().get<Trade>(tradeKey(winnerId));
    if (trade) {
      return { winner: false, id: winnerId, trade };
    }
  }

  // Edge case: won→lost but winner's record isn't in KV yet (extremely tight
  // race between write and the read above). Treat this request as the winner
  // with its own id — worst case the first record wins and the second is
  // orphaned, which is no worse than the pre-index behavior.
  return { winner: true, id };
}

async function submit(req: VercelRequest, res: VercelResponse) {
  if (isSpreadPayload(req.body)) return submitSpread(req, res);
  const draft = (req.body ?? {}) as OrderDraft;
  // Phase 2 follow-up #2: server-side `live` account guard. Without this, an
  // `account: 'live'` body would reach the real-money endpoint. Reject
  // explicitly unless the ops env var has been set to opt in.
  if (draft.account === 'live' && process.env.LIVE_ENABLED !== 'true') {
    return res.status(403).json({ error: 'live_trading_disabled' });
  }
  const validation_errors = validate(draft);
  if (validation_errors.length) return res.status(400).json({ error: 'validation_failed', validation_errors });

  // re-run preview math server-side
  const thresholds = (await kv().get<typeof DEFAULT_THRESHOLDS>(KV_KEYS.totpThresholds)) ?? DEFAULT_THRESHOLDS;
  const symbolForQuote = draft.asset_class === 'option' ? (draft.contract_symbol ?? draft.symbol) : draft.symbol;
  const { ask, bid } = await getQuote(symbolForQuote, draft.asset_class, modeFromAccount(draft.account));
  const exposure = computeExposure({
    asset_class: draft.asset_class, side: draft.side as any, qty: draft.qty,
    order_type: draft.order_type, limit_price: draft.limit_price,
    contract_type: draft.contract_type ?? null, strike: draft.strike ?? null, ask, bid,
  });
  const threshold = thresholds[draft.account] ?? Number.POSITIVE_INFINITY;
  if (exposure >= threshold) {
    if (!draft.totp_code || !verifyTotp(draft.totp_code, process.env.TOTP_SECRET ?? '')) {
      return res.status(401).json({ error: 'invalid_totp' });
    }
  }
  // Re-run rule checks server-side so the trade record reflects ground truth
  // at the moment of submission (block-severity rules can change between
  // /trades/check and /trades/submit if e.g. an earnings announcement lands).
  let positions: Array<{ symbol: string; qty: number; avg_entry_price: number }> = [];
  try {
    const raw = await alpacaTrade<Array<{ symbol: string; qty: string; avg_entry_price: string }>>(
      modeFromAccount(draft.account) as any,
      '/v2/positions',
    );
    positions = (raw ?? []).map((p) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avg_entry_price: parseFloat(p.avg_entry_price),
    }));
  } catch {
    positions = [];
  }
  const underlying_price = draft.asset_class === 'option'
    ? await getUnderlyingPrice(draft.symbol, modeFromAccount(draft.account))
    : null;
  const rule_warnings = await runRuleChecks(
    {
      asset_class: draft.asset_class,
      symbol: draft.symbol,
      qty: draft.qty,
      account: draft.account,
      side: draft.side as any,
      option_type: draft.contract_type ?? undefined,
      strike: draft.strike ?? null,
      expiration: draft.expiration ?? null,
      tags: Array.isArray(draft.tags) ? draft.tags : undefined,
      underlying_price,
    },
    { positions },
  );

  // Server is source of truth for which violations exist; the body provides
  // override_reason strings keyed by rule ID. Match them up.
  const submittedOverrides = (req.body as any)?.rule_violations as
    | Array<{ rule: string; severity?: string; override_reason?: string }>
    | undefined;
  const overrideByRule = new Map<string, string>();
  for (const v of submittedOverrides ?? []) {
    if (typeof v?.rule === 'string' && typeof v?.override_reason === 'string') {
      overrideByRule.set(v.rule, v.override_reason);
    }
  }

  // Block-severity violations from the server MUST have a >= 20-char override_reason
  // submitted with them. Otherwise reject the submission outright.
  for (const v of rule_warnings) {
    if (v.severity === 'block') {
      const reason = (overrideByRule.get(v.rule) ?? '').trim();
      if (reason.length < 20) {
        return res.status(400).json({
          error: 'block_severity_requires_override_reason',
          rule: v.rule,
          rule_message: v.message,
        });
      }
      // Attach the user's reasoning to the violation that gets persisted
      (v as any).override_reason = reason;
    }
  }

  // D2 — KV idempotency index: check/claim before allocating an id or hitting
  // Alpaca. If a prior request with the same idempotency_key already succeeded,
  // return that existing trade record immediately (no Alpaca call, no new
  // trade record). This closes the cross-request dedup gap where: request 1
  // places the order + writes record T-1, response is lost; request 2 would
  // previously allocate T-2 and call Alpaca again (422 caught → T-2 still
  // written as a phantom duplicate). With the index, request 2 short-circuits.
  const idemClaim = await claimIdemIndex(draft.idempotency_key);
  if (!idemClaim.winner) {
    // Another request already settled. Return the original trade record.
    const { id: origId, trade: origTrade } = idemClaim as ExistingClaim;
    return res.status(200).json({ id: origId, alpaca_order_id: origTrade.alpaca_order_id });
  }
  const id = idemClaim.id;
  // Use the caller-supplied idempotency key (generated once by ConfirmModal
  // and held in a ref across re-clicks). Fall back to a derivation from the
  // pre-allocated trade id so every order carries a client_order_id even when
  // the frontend didn't send one (import path, older clients).
  // NOTE: the `dash-<id>` fallback is NOT retry-idempotent — it derives from
  // a new id on every request. Only a stable caller-supplied key qualifies
  // for cross-request dedup via the KV index above.
  const clientOrderId = (draft.idempotency_key?.trim() ?? '') || `dash-${id}`;

  // Place the order via the direct trading-API helper, NOT the SDK. The
  // @alpacahq/typescript-sdk@0.0.32-preview ignores `paper: false` and routes
  // every trading request to paper-api.alpaca.markets — so a live order sent
  // through it carries live keys to the paper host, and Alpaca rejects it with
  // 40110000 "request is not authorized". alpacaTradeMutation honors
  // tradingBase(mode) → api.alpaca.markets for live. Mirrors submitSpread().
  // Map our STO/STC/BTO/BTC option side semantics to Alpaca's required
  // position_intent field. Without this, Alpaca rejects short-option opens
  // because it can't tell if `side: sell` means "open a short" or "close a
  // long you don't have." The wheel bot does the same — see
  // wheel_strategy.py:place_sell_to_open which sends sell_to_open explicitly.
  const positionIntent =
    draft.side === 'STO' ? 'sell_to_open'
    : draft.side === 'BTO' ? 'buy_to_open'
    : draft.side === 'STC' ? 'sell_to_close'
    : draft.side === 'BTC' ? 'buy_to_close'
    : undefined;
  const orderPayload: any = draft.asset_class === 'stock'
    ? {
        symbol: draft.symbol,
        qty: draft.qty,
        side: draft.side,
        type: draft.order_type === 'stop_limit' ? 'stop_limit' : draft.order_type,
        time_in_force: draft.tif,
        limit_price: draft.limit_price ?? undefined,
        stop_price: draft.stop_price ?? undefined,
        trail_percent: draft.trail_pct ?? undefined,
        client_order_id: clientOrderId,
      }
    : {
        symbol: draft.contract_symbol,
        qty: draft.qty,
        side: draft.side === 'BTO' || draft.side === 'BTC' ? 'buy' : 'sell',
        type: draft.order_type,
        time_in_force: draft.tif,
        limit_price: draft.limit_price ?? undefined,
        position_intent: positionIntent,
        client_order_id: clientOrderId,
      };
  let alpacaOrder: any;
  try {
    alpacaOrder = await alpacaTradeMutation<any>(
      modeFromAccount(draft.account) as any,
      '/v2/orders',
      { method: 'POST', body: orderPayload },
    );
  } catch (err) {
    // D2 — duplicate client_order_id: a prior attempt already created this
    // order (the HTTP response was lost before the client received it). Look
    // up the existing order rather than surfacing an error or double-placing.
    if (isDuplicateClientOrderIdError(err)) {
      const existing = await getOrderByClientOrderId(modeFromAccount(draft.account), clientOrderId);
      if (existing?.id) {
        alpacaOrder = existing;
      } else {
        // Lookup failed — fall through and surface the original error
        return res.status(502).json({
          error: 'alpaca_order_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Surface the Alpaca error verbatim — the previous behavior swallowed it
      // into a generic 500, which made order failures impossible to diagnose
      // from the UI. Most Alpaca rejects (422 insufficient_buying_power, 422
      // position_intent_required, 403 market_closed, etc.) carry the actionable
      // detail in the error message.
      return res.status(502).json({
        error: 'alpaca_order_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Snapshot Greeks for option opens
  let greeks_at_entry = null;
  if (draft.asset_class === 'option' && (draft.side === 'BTO' || draft.side === 'STO')) {
    const snap = await alpacaData<any>(modeFromAccount(draft.account) as any, '/v1beta1/options/snapshots', { symbols: draft.contract_symbol! });
    const g = snap?.snapshots?.[draft.contract_symbol!]?.greeks;
    if (g) greeks_at_entry = { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, iv: g.implied_volatility };
  }

  const cost_basis_at_entry = await resolveCostBasisForCc(
    {
      asset_class: draft.asset_class,
      side: draft.side,
      contract_type: draft.contract_type ?? null,
      symbol: draft.symbol,
    },
    async (underlying) => {
      try {
        return await alpacaTrade<{ avg_entry_price?: string }>(
          modeFromAccount(draft.account) as any,
          `/v2/positions/${encodeURIComponent(underlying)}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes(' 404 ')) return null;
        throw e;
      }
    },
  );
  const now = new Date();
  const trade: Trade = {
    id,
    account: draft.account,
    asset_class: draft.asset_class,
    symbol: draft.symbol,
    side: draft.side as any,
    qty: draft.qty,
    order_type: draft.order_type,
    limit_price: draft.limit_price,
    stop_price: draft.stop_price ?? null,
    trail_pct: draft.trail_pct ?? null,
    tif: draft.tif,
    contract_symbol: draft.contract_symbol ?? null,
    strike: draft.strike ?? null,
    expiration: draft.expiration ?? null,
    contract_type: draft.contract_type ?? null,
    greeks_at_entry,
    alpaca_order_id: alpacaOrder.id,
    alpaca_close_order_id: null,
    submitted_at: alpacaOrder.submitted_at ?? now.toISOString(),
    filled_at: null,
    filled_avg_price: null,
    closed_at: null,
    closed_avg_price: null,
    realized_pnl: null,
    closed_by: null,
    tags: draft.tags ?? [],
    entry_grade: draft.entry_grade as GradeLetter,
    entry_reasoning: draft.entry_reasoning,
    journal: '',
    exposure_at_submit: exposure,
    rule_warnings_at_entry: rule_warnings,
    modify_history: [],
    schema: 1,
    cost_basis_at_entry,
  };

  await kv().set(tradeKey(id), trade);
  await kv().set(gradeKey(id), {
    trade_id: id,
    entry: { letter: trade.entry_grade, reasoning: trade.entry_reasoning, ts: now.toISOString() },
    hindsight: null,
    history: [],
  });

  // Indexes
  await kv().rpush(KV_KEYS.tradesIndexOpen, id);
  await appendMonthIndex(currentMonth(now), id);

  return res.status(200).json({ id, alpaca_order_id: alpacaOrder.id });
}
async function list(req: VercelRequest, res: VercelResponse) {
  const q = req.query;
  const account = q.account ? String(q.account) : null;
  const asset_class = q.asset_class ? String(q.asset_class) : null;
  const tag = q.tag ? String(q.tag) : null;
  const grade = q.grade ? String(q.grade) : null;
  const status = q.status ? String(q.status) : null;
  const from = q.from ? String(q.from) : null;
  const to = q.to ? String(q.to) : null;
  // Cap at 10k — the /trades page's "all" chip sends 9999 to mean
  // "no per-page cap." Any limit above that is treated as 10k.
  const limit = Math.min(10000, Number(q.limit ?? 50));
  const offset = Math.max(0, Number(q.offset ?? 0));

  // collect month keys covering the date range — fall back to current + last 12 months
  const months: string[] = [];
  const start = from ? new Date(from) : new Date(Date.now() - 365 * 86400000);
  const end = to ? new Date(to) : new Date();
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const ids: string[] = [];
  for (const m of months) {
    const monthIds = await readMonthIndex(m);
    ids.push(...monthIds);
  }

  // de-dup, newest-first
  const uniqIds = Array.from(new Set(ids)).reverse();

  const records: Trade[] = [];
  const grades: any[] = [];
  for (const id of uniqIds) {
    const t = await kv().get<Trade>(tradeKey(id));
    if (!t) continue;
    if (account && t.account !== account) continue;
    if (asset_class && t.asset_class !== asset_class) continue;
    if (tag && !t.tags.includes(tag)) continue;
    if (grade && t.entry_grade !== grade) continue;
    if (status === 'open' && t.closed_at) continue;
    if (status === 'closed' && !t.closed_at) continue;
    records.push(t);
    const g = await kv().get<any>(gradeKey(id));
    if (g) grades.push(g);
  }

  // summary
  const closed = records.filter((r) => r.closed_at);
  const winRate = closed.length === 0 ? 0
    : closed.filter((r) => (r.realized_pnl ?? 0) > 0).length / closed.length;
  const cal = { matched: 0, over: 0, under: 0 };
  const recordById = new Map(records.map((r) => [r.id, r]));
  for (const g of grades) {
    if (!g.hindsight) continue;
    const t = recordById.get(g.trade_id);
    if (t?.ai_grade_inherited) continue; // M5.4: assignment-spawned trades inherit the parent's grade — don't double-count
    const c = g.hindsight.calibration;
    if (c === 'matched') cal.matched++;
    else if (c === 'over_1' || c === 'over_2') cal.over++;
    else if (c === 'under_1' || c === 'under_2') cal.under++;
  }

  // Build a parallel array of compact grade summaries so the table can render AI letters + calibration colors
  const gradeSummaries = records.map((t) => {
    const g = grades.find((gr: any) => gr.trade_id === t.id);
    return {
      trade_id: t.id,
      ai_letter: g?.hindsight?.letter ?? null,
      calibration: g?.hindsight?.calibration ?? null,
    };
  });

  return res.status(200).json({
    trades: records.slice(offset, offset + limit),
    grades: gradeSummaries.slice(offset, offset + limit),
    total: records.length,
    summary: { count: records.length, win_rate: winRate, calibration: cal },
  });
}

async function getOne(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'id_required' });
  const trade = await kv().get<Trade>(tradeKey(id));
  const grade = await kv().get<any>(gradeKey(id));
  if (!trade) return res.status(404).json({ error: 'not_found' });
  // M5.3: if this trade has spawned a child via assignment auto-spawn,
  // surface the child id so the UI can link to it.
  const assignment_child_id = await kv().get<string>(assignmentChildKey(id));
  return res.status(200).json({ trade, grade, assignment_child_id: assignment_child_id ?? null });
}
async function regrade(req: VercelRequest, res: VercelResponse) {
  const id = String((req.body as any)?.id ?? req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'id_required' });

  const trade = await kv().get<Trade>(tradeKey(id));
  const grade = await kv().get<any>(gradeKey(id));
  if (!trade) return res.status(404).json({ error: 'trade_not_found' });
  if (!grade) return res.status(404).json({ error: 'grade_not_found' });

  // AI grading is restricted to manual + live. The UI hides the regrade button
  // on other accounts; this is the server-side guard for a hand-crafted request.
  if (!isGradeable(trade.account)) {
    return res.status(403).json({ error: 'grading_disabled_for_account', account: trade.account });
  }

  // Pull bars across position lifetime
  const start = trade.filled_at ?? trade.submitted_at;
  const end = trade.closed_at ?? new Date().toISOString();
  let bars: Array<{ t: string; c: number }> = [];
  try {
    const data = await alpacaData<any>(modeFromAccount(trade.account) as any, '/v2/stocks/bars', {
      symbols: trade.symbol, timeframe: '1Min', start, end, limit: 500,
    });
    bars = (data?.bars?.[trade.symbol] ?? []).map((b: any) => ({ t: b.t, c: b.c }));
  } catch { /* bars are optional */ }

  const hindsight = await gradeTrade({ trade, bars });

  const history = grade.hindsight
    ? [{ entry: grade.entry, hindsight: grade.hindsight }, ...(grade.history ?? [])]
    : (grade.history ?? []);
  const next = { ...grade, hindsight, history };
  await kv().set(gradeKey(id), next);
  return res.status(200).json({ grade: next });
}

async function calendar(req: VercelRequest, res: VercelResponse) {
  const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'invalid_month_format' });
  }
  const account = req.query.account as string | undefined;
  const symbol = req.query.symbol as string | undefined;
  const tag = req.query.tag as string | undefined;
  const asset_class = req.query.asset_class as string | undefined;

  const ids = await readMonthIndex(month);
  const records = (await Promise.all(ids.map((id) => kv().get<Trade>(tradeKey(id)))))
    .filter((t): t is Trade => !!t)
    .filter((t) => account ? t.account === account : true)
    .filter((t) => symbol ? t.symbol === symbol : true)
    .filter((t) => tag ? t.tags.includes(tag) : true)
    .filter((t) => asset_class ? t.asset_class === asset_class : true);

  // Open trades (across all months) need to be considered for the
  // expiration overlay since their expiration may fall in this month
  // even if they were opened earlier.
  const openIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];
  const openTrades = (await Promise.all(openIds.map((id) => kv().get<Trade>(tradeKey(id)))))
    .filter((t): t is Trade => !!t)
    .filter((t) => account ? t.account === account : true)
    .filter((t) => symbol ? t.symbol === symbol : true)
    .filter((t) => tag ? t.tags.includes(tag) : true)
    .filter((t) => asset_class ? t.asset_class === asset_class : true);

  interface DayBucket {
    realized_pnl: number;
    trade_count: number;
    closed_trade_ids: string[];
    open_options_expiring: Array<{ trade_id: string; symbol: string; option_type: 'put' | 'call'; strike: number }>;
  }
  const days: Record<string, DayBucket> = {};

  for (const t of records) {
    if (t.closed_at) {
      const day = t.closed_at.slice(0, 10);
      const b = days[day] ??= { realized_pnl: 0, trade_count: 0, closed_trade_ids: [], open_options_expiring: [] };
      b.realized_pnl += t.realized_pnl ?? 0;
      b.trade_count += 1;
      b.closed_trade_ids.push(t.id);
    }
  }
  for (const t of openTrades) {
    if (t.asset_class === 'option' && t.expiration && t.expiration.startsWith(month)) {
      const day = t.expiration;
      const b = days[day] ??= { realized_pnl: 0, trade_count: 0, closed_trade_ids: [], open_options_expiring: [] };
      b.open_options_expiring.push({
        trade_id: t.id,
        symbol: t.symbol,
        option_type: (t.contract_type ?? 'put') as 'put' | 'call',
        strike: t.strike ?? 0,
      });
    }
  }

  const month_total = Object.values(days).reduce((s, d) => s + d.realized_pnl, 0);
  return res.status(200).json({ days, month_total });
}

async function performance(req: VercelRequest, res: VercelResponse) {
  const account = req.query.account as string | undefined;
  const tag = req.query.tag as string | undefined;
  const asset_class = req.query.asset_class as string | undefined;
  const dateRange = String(req.query.date_range ?? 'ALL');

  const cutoff = dateRangeToCutoff(dateRange);
  const months = monthsInRange(cutoff, new Date());

  const idsByMonth = await Promise.all(months.map((m) => readMonthIndex(m)));
  const ids = idsByMonth.flat();

  const rawTrades = await Promise.all(ids.map((id) => kv().get<Trade>(tradeKey(id))));
  const trades = rawTrades
    .filter((t): t is Trade => !!t)
    .filter((t) => account ? t.account === account : true)
    .filter((t) => tag ? t.tags.includes(tag) : true)
    .filter((t) => asset_class ? t.asset_class === asset_class : true);

  const grades = await Promise.all(trades.map((t) => kv().get<any>(gradeKey(t.id))));

  // Calibration scatter — exclude inherited grades (M5.4 rationale)
  interface CalPoint { trade_id: string; user_grade: number; ai_grade: number; }
  const calibration: CalPoint[] = [];
  trades.forEach((t, i) => {
    if (t.ai_grade_inherited) return;
    const aiLetter = grades[i]?.hindsight?.letter;
    if (!aiLetter) return;
    calibration.push({
      trade_id: t.id,
      user_grade: gradeToNum(t.entry_grade),
      ai_grade: gradeToNum(aiLetter),
    });
  });

  // Win rate by tag
  interface TagBucket { tag: string; trades: number; wins: number; total_pnl: number; }
  const tagBuckets = new Map<string, TagBucket>();
  for (const t of trades) {
    if (!t.closed_at) continue;
    for (const tg of t.tags) {
      const b = tagBuckets.get(tg) ?? { tag: tg, trades: 0, wins: 0, total_pnl: 0 };
      b.trades += 1;
      b.wins += (t.realized_pnl ?? 0) > 0 ? 1 : 0;
      b.total_pnl += t.realized_pnl ?? 0;
      tagBuckets.set(tg, b);
    }
  }
  const win_rate_by_tag = Array.from(tagBuckets.values()).sort((a, b) => b.trades - a.trades);

  // P&L by symbol
  interface SymBucket { symbol: string; trades: number; wins: number; total_pnl: number; grade_sum: number; }
  const symBuckets = new Map<string, SymBucket>();
  trades.forEach((t) => {
    if (!t.closed_at) return;
    const b = symBuckets.get(t.symbol) ?? { symbol: t.symbol, trades: 0, wins: 0, total_pnl: 0, grade_sum: 0 };
    b.trades += 1;
    b.wins += (t.realized_pnl ?? 0) > 0 ? 1 : 0;
    b.total_pnl += t.realized_pnl ?? 0;
    b.grade_sum += gradeToNum(t.entry_grade);
    symBuckets.set(t.symbol, b);
  });
  const pnl_by_symbol = Array.from(symBuckets.values())
    .map((b) => ({ symbol: b.symbol, trades: b.trades, wins: b.wins, total_pnl: b.total_pnl, avg_grade: b.grade_sum / b.trades }))
    .sort((a, b) => b.total_pnl - a.total_pnl);

  // Time-of-day heatmap (Mon-Fri × 9-15 ET, by closed_at)
  interface HeatCell { dow: number; hour: number; trades: number; win_rate: number; }
  const heatRaw = new Map<string, { dow: number; hour: number; trades: number; wins: number }>();
  for (const t of trades) {
    if (!t.closed_at) continue;
    const closeDate = new Date(t.closed_at);
    const offsetMin = etOffsetMinutes(closeDate);
    const local = new Date(closeDate.getTime() + offsetMin * 60_000);
    const dow = local.getUTCDay();
    if (dow < 1 || dow > 5) continue;
    const hour = local.getUTCHours();
    if (hour < 9 || hour > 15) continue;
    const k = `${dow}-${hour}`;
    const cell = heatRaw.get(k) ?? { dow, hour, trades: 0, wins: 0 };
    cell.trades += 1;
    cell.wins += (t.realized_pnl ?? 0) > 0 ? 1 : 0;
    heatRaw.set(k, cell);
  }
  const time_heatmap: HeatCell[] = Array.from(heatRaw.values()).map((h) => ({
    dow: h.dow, hour: h.hour, trades: h.trades,
    win_rate: h.trades ? h.wins / h.trades : 0,
  }));

  return res.status(200).json({
    cutoff: cutoff.toISOString(),
    calibration,
    win_rate_by_tag,
    pnl_by_symbol,
    time_heatmap,
  });
}

function dateRangeToCutoff(r: string): Date {
  const now = new Date();
  switch (r) {
    case '1W': return new Date(now.getTime() -   7 * 86400000);
    case '1M': return new Date(now.getTime() -  30 * 86400000);
    case '3M': return new Date(now.getTime() -  90 * 86400000);
    case '1Y': return new Date(now.getTime() - 365 * 86400000);
    default:   return new Date(2020, 0, 1);
  }
}

function monthsInRange(start: Date, end: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(start.getFullYear(), start.getMonth(), 1));
  const endUtc = new Date(Date.UTC(end.getFullYear(), end.getMonth(), 1));
  while (d <= endUtc) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

function gradeToNum(letter: string): number {
  const order = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];
  const idx = order.indexOf(letter);
  return idx === -1 ? 5 : 11 - idx;
}

// ---------------------------------------------------------------------------
// Import from Alpaca activity log (settings → bottom-of-page one-shot)
//
// Backfills trade records for opening fills that landed in Alpaca but never
// got a dashboard record — e.g. positions opened directly on Alpaca's web UI
// before the dashboard's spread form shipped, or wheel positions the bot
// opened/managed before the external-close detection was wired up. Only
// creates records for OPENS (STO/BTO); the cron's external-close detection
// path (cron/[job].ts detectExternalOptionClose / detectExternalSpreadClose)
// will subsequently fill in close data on the next tick.
//
// Spread pairing heuristic: same underlying + same expiration + same fill
// timestamp (within SPREAD_PAIR_WINDOW_MS) + opposite buy/sell + put or call.
// Strikes must differ (otherwise it's a roll, not a vertical). Pairs once;
// duplicate IDs are skipped via the per-month index check.
// ---------------------------------------------------------------------------

const SPREAD_PAIR_WINDOW_MS = 5_000;

interface ImportRequest {
  account: OrderDraft['account'];
  since: string; // ISO timestamp
}

interface RawFill {
  id?: string;
  activity_type?: string;
  transaction_time?: string;
  symbol?: string;          // OCC for options, ticker for stocks
  side?: string;            // 'buy' | 'sell' | 'sell_short'
  price?: string;
  qty?: string;
  order_id?: string;
  /** Alpaca FILL field — 'opening' | 'closing'. Present on options fills; may
   *  be absent on legacy records or certain account types.  When absent we treat
   *  the fill as opening (safe default — we must not silently drop genuine
   *  opens just because the field is missing). */
  position_effect?: string;
}

interface ParsedOcc {
  underlying: string;
  expiration: string;       // YYYY-MM-DD
  type: 'put' | 'call';
  strike: number;
}

/** Parse an OCC option symbol like `AAL260529P00012500` into its components. */
export function parseOcc(occ: string): ParsedOcc | null {
  // Underlying is the leading [A-Z]+ run; the rest is YYMMDD + P|C + strike*1000 (8 digits)
  const m = /^([A-Z]+)(\d{6})([PC])(\d{8})$/.exec(occ);
  if (!m) return null;
  const [, underlying, ymd, pc, strike8] = m;
  const yy = ymd.slice(0, 2);
  const mm = ymd.slice(2, 4);
  const dd = ymd.slice(4, 6);
  const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  return {
    underlying,
    expiration: `${year}-${mm}-${dd}`,
    type: pc === 'P' ? 'put' : 'call',
    strike: Number(strike8) / 1000,
  };
}

interface SpreadPair {
  short: RawFill;             // STO leg
  long: RawFill;              // BTO leg
  short_occ: ParsedOcc;
  long_occ: ParsedOcc;
}

/**
 * Group raw fills into spread pairs + leftover singles.
 *
 * A spread pair is two fills that:
 *   - share underlying + expiration + option type (both puts OR both calls)
 *   - have opposite sides (one buy, one sell)
 *   - have different strikes
 *   - posted within SPREAD_PAIR_WINDOW_MS of each other
 *   - have equal qty
 *
 * Determinism: fills are processed in chronological order. The first
 * unpaired fill scans forward for a partner; once paired, both are
 * consumed and excluded from further matching.
 */
export function groupFillsIntoSpreadsAndSingles(
  fills: RawFill[],
): { pairs: SpreadPair[]; singles: RawFill[] } {
  const sorted = [...fills].sort((a, b) =>
    Date.parse(a.transaction_time ?? '') - Date.parse(b.transaction_time ?? ''));
  const consumed = new Set<number>();
  const pairs: SpreadPair[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (consumed.has(i)) continue;
    const a = sorted[i];
    if (!a.symbol) continue;
    const aOcc = parseOcc(a.symbol);
    if (!aOcc) continue; // not an option — singles handling
    const aTs = Date.parse(a.transaction_time ?? '');
    if (!Number.isFinite(aTs)) continue;
    const aSide = (a.side ?? '').toLowerCase();
    if (aSide !== 'buy' && aSide !== 'sell' && aSide !== 'sell_short') continue;

    for (let j = i + 1; j < sorted.length; j++) {
      if (consumed.has(j)) continue;
      const b = sorted[j];
      if (!b.symbol) continue;
      const bOcc = parseOcc(b.symbol);
      if (!bOcc) continue;
      const bTs = Date.parse(b.transaction_time ?? '');
      if (!Number.isFinite(bTs)) continue;
      if (bTs - aTs > SPREAD_PAIR_WINDOW_MS) break; // sorted — nothing else fits
      if (aOcc.underlying !== bOcc.underlying) continue;
      if (aOcc.expiration !== bOcc.expiration) continue;
      if (aOcc.type !== bOcc.type) continue;
      if (aOcc.strike === bOcc.strike) continue;
      if ((a.qty ?? '') !== (b.qty ?? '')) continue;
      const bSide = (b.side ?? '').toLowerCase();
      // Opposite sides — one buy + one sell
      const aIsSell = aSide === 'sell' || aSide === 'sell_short';
      const bIsSell = bSide === 'sell' || bSide === 'sell_short';
      if (aIsSell === bIsSell) continue;
      // Pair! Identify which is short (sell) vs long (buy).
      const shortFill = aIsSell ? a : b;
      const longFill = aIsSell ? b : a;
      const shortOcc = aIsSell ? aOcc : bOcc;
      const longOcc = aIsSell ? bOcc : aOcc;
      pairs.push({ short: shortFill, long: longFill, short_occ: shortOcc, long_occ: longOcc });
      consumed.add(i);
      consumed.add(j);
      break;
    }
  }

  const singles = sorted.filter((_, i) => !consumed.has(i));
  return { pairs, singles };
}

/**
 * True iff `orderId` already appears on a trade record in the per-month
 * index for the fill's month. Cheap dedup — we don't walk the whole index,
 * just the one month the fill belongs to.
 */
async function orderIdAlreadyImported(orderId: string, fillTime: string): Promise<boolean> {
  const month = fillTime.slice(0, 7);
  const ids = await readMonthIndex(month);
  for (const id of ids) {
    const t = await kv().get<Trade>(tradeKey(id));
    if (!t) continue;
    if (t.alpaca_order_id === orderId) return true;
    // Also catch spread legs where the short leg's order id matches
    if (t.asset_class === 'spread' && t.spread) {
      if ((t.spread.short_leg as any).order_id === orderId) return true;
    }
  }
  return false;
}

async function importFromAlpaca(req: VercelRequest, res: VercelResponse) {
  const body = (req.body ?? {}) as Partial<ImportRequest>;
  const account = body.account as OrderDraft['account'];
  const since = body.since;
  if (!account || !since) return res.status(400).json({ error: 'account_and_since_required' });
  if (account === 'live' && process.env.LIVE_ENABLED !== 'true') {
    return res.status(403).json({ error: 'live_trading_disabled' });
  }
  const sinceTs = Date.parse(since);
  if (!Number.isFinite(sinceTs)) return res.status(400).json({ error: 'invalid_since_timestamp' });
  try {
    const summary = await runImport({ account, since });
    // Advance the auto-import cursor so the next cron tick starts from "now"
    // instead of re-walking the same window. Idempotent — dedup would catch
    // duplicates anyway, but this saves an Alpaca round-trip per account.
    await kv().set(importCursorKey(account), new Date().toISOString());
    return res.status(200).json({ imported: summary });
  } catch (e) {
    return res.status(502).json({
      error: 'alpaca_activities_fetch_failed',
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Pure import worker — pulls FILL activities since `since` for the given
 * account, pairs option fills into spreads when possible, and writes
 * dashboard trade records for opening fills (STO/BTO). Used by both the
 * HTTP /api/trades/import endpoint AND the grade-open-trades cron's
 * auto-import pass. Closes get picked up separately by the cron's
 * external-close detection on the next tick.
 *
 * extraTags is added to every imported trade in addition to 'imported'
 * (cron uses ['bot_opened'] for accounts where every trade is bot-opened).
 */
export async function runImport({
  account,
  since,
  extraTags = [],
}: {
  account: OrderDraft['account'];
  since: string;
  extraTags?: string[];
}): Promise<TradeImportSummary> {
  const summary: TradeImportSummary = {
    imported: 0,
    skipped_existing: 0,
    spread_pairs_found: 0,
    errors: [],
    created_trade_ids: [],
  };

  const baseTags = ['imported', ...extraTags.filter((t) => t !== 'imported')];
  const mode = modeFromAccount(account);

  // Alpaca caps page_size at 100 on /v2/account/activities. Paginate via the
  // `page_token` cursor (last record's id) until we get a partial or empty page.
  // Hard cap at 50 pages (5000 fills) so a runaway never wedges the cron.
  const PAGE_SIZE = 100;
  const MAX_PAGES = 50;
  const activities: RawFill[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params: Record<string, string | number> = {
      activity_types: 'FILL',
      after: since.slice(0, 10),
      page_size: PAGE_SIZE,
    };
    if (pageToken) params.page_token = pageToken;
    const page = await alpacaTrade<RawFill[]>(mode as any, '/v2/account/activities', params);
    if (!Array.isArray(page) || page.length === 0) break;
    activities.push(...page);
    if (page.length < PAGE_SIZE) break;
    const lastId = page[page.length - 1]?.id;
    if (!lastId) break;
    pageToken = lastId;
  }

  // D15: client-side timestamp filter.  Alpaca's `after` param is DATE-granular
  // (YYYY-MM-DD), so it re-offers ALL fills from the cursor date regardless of
  // the time component.  Without this guard, fills that happened before the
  // precise `since` timestamp but on the same calendar date would pass the
  // date-only filter and — if they hadn't been imported yet — create duplicate
  // trade records.  Drop any fill whose precise transaction_time is on or before
  // the full ISO `since` cursor so only truly new fills reach the import logic.
  // Fills with a missing/invalid timestamp are kept (safe default — we must not
  // silently drop genuine opens just because the timestamp field is absent).
  const sinceTs = Date.parse(since);
  const afterSince: RawFill[] = Number.isFinite(sinceTs)
    ? activities.filter((a) => {
        const ts = Date.parse(a.transaction_time ?? '');
        // If the fill timestamp is parseable and is <= the since cursor, drop it.
        return !Number.isFinite(ts) || ts > sinceTs;
      })
    : activities;

  // Only OPENING fills are imported here — closes will be picked up by the
  // cron's external-close detection on the next tick.
  // For options: STO (sell_short) and BTO (buy that creates a new long).
  // For stocks: skipped in v1 (FIFO matching not implemented; see brief).
  // For spreads: detected by pairing two option fills.

  // D5: only import OPENING fills. Alpaca FILL activities carry a
  // `position_effect` field ('opening' | 'closing') that distinguishes a
  // short-open / long-open from a buy-to-close / sell-to-close. Without this
  // filter a BTC fill (side:'buy') was misclassified as a BTO open → phantom
  // duplicate trade record on the next auto-import window.
  //
  // Safe-default: if the field is absent (legacy records, account types that
  // don't return it) we treat the fill as opening. We must not silently drop
  // legitimate opens just because the field is missing.
  const openingFills: RawFill[] = afterSince.filter((a) => {
    const pe = (a.position_effect ?? '').toLowerCase();
    return pe !== 'closing';
  });

  const optionFills: RawFill[] = openingFills.filter((a) => {
    if (!a.symbol) return false;
    return parseOcc(a.symbol) !== null;
  });

  const { pairs, singles } = groupFillsIntoSpreadsAndSingles(optionFills);
  summary.spread_pairs_found = pairs.length;

  // Handle spread pairs (credit-spread-shaped only — STO + BTO at different strikes)
  for (const pair of pairs) {
    try {
      const shortOrderId = pair.short.order_id ?? '';
      const fillTime = pair.short.transaction_time ?? new Date().toISOString();
      if (shortOrderId && await orderIdAlreadyImported(shortOrderId, fillTime)) {
        summary.skipped_existing += 1;
        continue;
      }
      const qty = Number(pair.short.qty ?? '1');
      const shortPx = Number(pair.short.price ?? '0');
      const longPx = Number(pair.long.price ?? '0');
      if (!Number.isFinite(qty) || qty <= 0) {
        summary.errors.push(`bad qty on ${pair.short.symbol}`);
        continue;
      }
      // Identify which leg is which by strike for a credit spread:
      //   put credit:  short strike HIGHER than long strike
      //   call credit: short strike LOWER than long strike
      // The pairing already enforced short=sell side / long=buy side; for now
      // we only model put_credit (mirrors SpreadDetails.spread_type union).
      if (pair.short_occ.type !== 'put') {
        summary.errors.push(`only put_credit spreads supported in v1 (${pair.short.symbol})`);
        continue;
      }
      if (pair.short_occ.strike < pair.long_occ.strike) {
        summary.errors.push(`unrecognized spread shape on ${pair.short.symbol} (short strike below long strike)`);
        continue;
      }
      const width = Math.abs(pair.short_occ.strike - pair.long_occ.strike);
      const netCredit = shortPx - longPx;
      const maxLoss = width - netCredit;
      const id = await allocateTradeId();
      const now = new Date(fillTime);
      const trade: Trade = {
        id,
        account,
        asset_class: 'spread',
        symbol: pair.short_occ.underlying,
        side: 'STO',
        qty,
        order_type: 'limit',
        limit_price: -netCredit, // credit convention: negative net price
        stop_price: null,
        trail_pct: null,
        tif: 'day',
        contract_symbol: pair.short.symbol ?? null,
        strike: pair.short_occ.strike,
        expiration: pair.short_occ.expiration,
        contract_type: 'put',
        greeks_at_entry: null,
        alpaca_order_id: shortOrderId,
        alpaca_close_order_id: null,
        submitted_at: fillTime,
        filled_at: fillTime,
        filled_avg_price: netCredit,
        closed_at: null,
        closed_avg_price: null,
        realized_pnl: null,
        closed_by: null,
        tags: baseTags,
        // Imports have no user-assigned grade. The schema requires a letter,
        // so we seed 'C' (neutral) and tag with 'imported' so the calibration
        // math + grading consumers can filter these out if needed.
        entry_grade: 'C',
        entry_reasoning: 'Imported from Alpaca activity log (originally opened outside dashboard)',
        journal: '',
        exposure_at_submit: maxLoss * 100 * qty,
        rule_warnings_at_entry: [],
        modify_history: [],
        // Imported records come straight from a FILL activity — they are filled
        // by definition. Stamp fill_confirmed so detectExternalSpreadClose's D14
        // guard doesn't defer the bot-close for 24h waiting on a sync that has
        // nothing left to confirm.
        fill_confirmed: true,
        schema: 1,
        spread: {
          spread_type: 'put_credit',
          short_leg: {
            occ: pair.short.symbol ?? '',
            strike: pair.short_occ.strike,
            entry_premium: shortPx,
            fill_price: shortPx,
            qty,
            order_id: shortOrderId || undefined,
          },
          long_leg: {
            occ: pair.long.symbol ?? '',
            strike: pair.long_occ.strike,
            entry_premium: longPx,
            fill_price: longPx,
            qty,
            order_id: pair.long.order_id ?? undefined,
          },
          expiration: pair.short_occ.expiration,
          width,
          net_credit: netCredit,
          max_loss: maxLoss,
        },
      };
      await kv().set(tradeKey(id), trade);
      await kv().set(gradeKey(id), {
        trade_id: id,
        entry: {
          letter: trade.entry_grade,
          reasoning: trade.entry_reasoning,
          ts: fillTime,
        },
        hindsight: null,
        history: [],
      });
      await kv().rpush(KV_KEYS.tradesIndexOpen, id);
      await appendMonthIndex(currentMonth(now), id);
      summary.imported += 1;
      summary.created_trade_ids.push(id);
    } catch (e) {
      summary.errors.push(`spread ${pair.short.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Handle single option fills that are OPENS
  for (const f of singles) {
    try {
      const occ = parseOcc(f.symbol ?? '');
      if (!occ) continue;
      const sideRaw = (f.side ?? '').toLowerCase();
      // STO = sell_short option (opening short); BTO = buy option that opens a long
      // Alpaca options use side='sell' for short-option opens — we infer
      // STO when there's no preceding long position. But for v1 we use the
      // simple heuristic: 'sell_short' OR 'sell' = STO open, 'buy' = BTO open.
      // Closes (BTC/STC) are matched by the cron's external-close path.
      let side: 'STO' | 'BTO';
      if (sideRaw === 'sell_short' || sideRaw === 'sell') side = 'STO';
      else if (sideRaw === 'buy') side = 'BTO';
      else continue;
      const orderId = f.order_id ?? '';
      const fillTime = f.transaction_time ?? new Date().toISOString();
      if (orderId && await orderIdAlreadyImported(orderId, fillTime)) {
        summary.skipped_existing += 1;
        continue;
      }
      const qty = Number(f.qty ?? '1');
      const price = Number(f.price ?? '0');
      if (!Number.isFinite(qty) || qty <= 0) {
        summary.errors.push(`bad qty on ${f.symbol}`);
        continue;
      }
      const id = await allocateTradeId();
      const now = new Date(fillTime);
      const trade: Trade = {
        id,
        account,
        asset_class: 'option',
        symbol: occ.underlying,
        side,
        qty,
        order_type: 'limit',
        limit_price: price,
        stop_price: null,
        trail_pct: null,
        tif: 'day',
        contract_symbol: f.symbol ?? null,
        strike: occ.strike,
        expiration: occ.expiration,
        contract_type: occ.type,
        greeks_at_entry: null,
        alpaca_order_id: orderId,
        alpaca_close_order_id: null,
        submitted_at: fillTime,
        filled_at: fillTime,
        filled_avg_price: price,
        closed_at: null,
        closed_avg_price: null,
        realized_pnl: null,
        closed_by: null,
        tags: baseTags,
        entry_grade: 'C',
        entry_reasoning: 'Imported from Alpaca activity log (originally opened outside dashboard)',
        journal: '',
        exposure_at_submit: price * 100 * qty,
        rule_warnings_at_entry: [],
        modify_history: [],
        // Imported from a FILL activity — filled by definition (see spread note above).
        fill_confirmed: true,
        schema: 1,
      };
      await kv().set(tradeKey(id), trade);
      await kv().set(gradeKey(id), {
        trade_id: id,
        entry: {
          letter: trade.entry_grade,
          reasoning: trade.entry_reasoning,
          ts: fillTime,
        },
        hindsight: null,
        history: [],
      });
      await kv().rpush(KV_KEYS.tradesIndexOpen, id);
      await appendMonthIndex(currentMonth(now), id);
      summary.imported += 1;
      summary.created_trade_ids.push(id);
    } catch (e) {
      summary.errors.push(`single ${f.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return summary;
}

async function updateTrade(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? (req.body as Record<string, unknown>)?.id ?? '');
  if (!id) return res.status(400).json({ error: 'id_required' });
  const body = (req.body ?? {}) as { journal?: string; tags?: string[] };
  const trade = await kv().get<Trade>(tradeKey(id));
  if (!trade) return res.status(404).json({ error: 'not_found' });
  const updated: Trade = {
    ...trade,
    journal: typeof body.journal === 'string' ? body.journal : trade.journal,
    tags: Array.isArray(body.tags) ? body.tags : trade.tags,
  };
  await kv().set(tradeKey(id), updated);
  return res.status(200).json({ ok: true });
}
