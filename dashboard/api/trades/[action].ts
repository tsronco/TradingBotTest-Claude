// dashboard/api/trades/[action].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { requireAuth } from '../_lib/auth-guard.js';
import { computeExposure } from '../_lib/exposure.js';
import { runStubRuleChecks, runRuleChecks } from '../_lib/rule-check.js';
import { alpacaData, alpacaTrade } from '../_lib/data-api.js';
import { GRADE_LETTERS, type GradeLetter, type Trade } from '../_lib/trade-types.js';
import { allocateTradeId, currentMonth } from '../_lib/trade-ids.js';
import {
  KV_KEYS, tradeKey, gradeKey, tradesIndexMonthKey, assignmentChildKey,
} from '../_lib/kv-keys.js';
import { alpacaFor } from '../_lib/alpaca.js';
import { verifyTotp } from '../_lib/totp.js';
import { gradeTrade } from '../_lib/grading.js';
import { etOffsetMinutes } from '../_lib/et-time.js';

interface OrderDraft {
  account: 'conservative_paper' | 'aggressive_paper' | 'manual_paper' | 'live';
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
}

const DEFAULT_THRESHOLDS = { conservative_paper: 5000, aggressive_paper: 10000, manual_paper: 2500, live: 1500 };

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

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
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

function modeFromAccount(account: string): string {
  if (account === 'aggressive_paper') return 'aggressive';
  if (account === 'manual_paper') return 'manual';
  return 'conservative';
}

async function check(req: VercelRequest, res: VercelResponse) {
  const draft = (req.body ?? {}) as Partial<OrderDraft> & {
    option_type?: 'put' | 'call';
    strike?: number | null;
    expiration?: string | null;
    tags?: string[];
  };

  const account = (draft.account ?? 'conservative_paper') as OrderDraft['account'];
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

  const violations = await runRuleChecks(
    {
      asset_class: (draft.asset_class as 'stock' | 'option') ?? 'stock',
      symbol: String(draft.symbol ?? ''),
      qty: Number(draft.qty ?? 0),
      account,
      side: draft.side as any,
      option_type: draft.option_type,
      strike: draft.strike ?? null,
      expiration: draft.expiration ?? null,
      tags: Array.isArray(draft.tags) ? draft.tags : undefined,
    },
    { positions },
  );

  return res.status(200).json({ violations });
}

async function preview(req: VercelRequest, res: VercelResponse) {
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
    rule_warnings = await runStubRuleChecks({
      asset_class: draft.asset_class, symbol: draft.symbol,
      qty: draft.qty, account: draft.account,
    });
  }

  return res.status(200).json({ exposure, requires_totp, rule_warnings, validation_errors });
}

async function submit(req: VercelRequest, res: VercelResponse) {
  const draft = (req.body ?? {}) as OrderDraft;
  // Phase 2 follow-up #2: server-side `live` account guard. The dashboard
  // doesn't have wired live Alpaca creds; without this, an `account: 'live'`
  // body silently routes to conservative paper. Reject explicitly unless the
  // ops env var has been set to opt in.
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

  // Alpaca submit (paper for now)
  const client = alpacaFor(modeFromAccount(draft.account) as any);
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
      }
    : {
        symbol: draft.contract_symbol,
        qty: draft.qty,
        side: draft.side === 'BTO' || draft.side === 'BTC' ? 'buy' : 'sell',
        type: draft.order_type,
        time_in_force: draft.tif,
        limit_price: draft.limit_price ?? undefined,
        position_intent: positionIntent,
      };
  let alpacaOrder: any;
  try {
    alpacaOrder = await client.createOrder(orderPayload);
  } catch (err) {
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

  // Snapshot Greeks for option opens
  let greeks_at_entry = null;
  if (draft.asset_class === 'option' && (draft.side === 'BTO' || draft.side === 'STO')) {
    const snap = await alpacaData<any>(modeFromAccount(draft.account) as any, '/v1beta1/options/snapshots', { symbols: draft.contract_symbol! });
    const g = snap?.snapshots?.[draft.contract_symbol!]?.greeks;
    if (g) greeks_at_entry = { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, iv: g.implied_volatility };
  }

  const id = await allocateTradeId();
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
  const monthKey = tradesIndexMonthKey(currentMonth(now));
  const monthList = (await kv().get<string[]>(monthKey)) ?? [];
  await kv().set(monthKey, [...monthList, id]);

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
  const limit = Math.min(200, Number(q.limit ?? 50));
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
    const monthIds = (await kv().get<string[]>(tradesIndexMonthKey(m))) ?? [];
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

  const ids = (await kv().get<string[]>(tradesIndexMonthKey(month))) ?? [];
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

  const idsByMonth = await Promise.all(
    months.map((m) => kv().get<string[]>(tradesIndexMonthKey(m))),
  );
  const ids = idsByMonth.flat().filter((x): x is string => !!x);

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
