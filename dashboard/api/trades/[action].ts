// dashboard/api/trades/[action].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { requireAuth } from '../_lib/auth-guard.js';
import { computeExposure } from '../_lib/exposure.js';
import { runStubRuleChecks } from '../_lib/rule-check.js';
import { alpacaData } from '../_lib/data-api.js';
import { GRADE_LETTERS, type GradeLetter, type Trade } from '../_lib/trade-types.js';
import { allocateTradeId, currentMonth } from '../_lib/trade-ids.js';
import {
  KV_KEYS, tradeKey, gradeKey, tradesIndexMonthKey,
} from '../_lib/kv-keys.js';
import { alpacaFor } from '../_lib/alpaca.js';
import { verifyTotp } from '../_lib/totp.js';
import { gradeTrade } from '../_lib/grading.js';

interface OrderDraft {
  account: 'conservative_paper' | 'aggressive_paper' | 'live';
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

const DEFAULT_THRESHOLDS = { conservative_paper: 5000, aggressive_paper: 10000, live: 1500 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  const action = String(req.query.action ?? '');

  if (req.method === 'POST' && action === 'preview') return preview(req, res);
  if (req.method === 'POST' && action === 'submit') return submit(req, res);
  if (req.method === 'GET' && action === 'list') return list(req, res);
  if (req.method === 'GET' && action === 'get') return getOne(req, res);
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
  return 'conservative';
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
  const rule_warnings = await runStubRuleChecks({
    asset_class: draft.asset_class, symbol: draft.symbol, qty: draft.qty, account: draft.account,
  });

  // Alpaca submit (paper for now)
  const client = alpacaFor(modeFromAccount(draft.account) as any);
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
      };
  const alpacaOrder = await client.createOrder(orderPayload);

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
  for (const g of grades) {
    if (!g.hindsight) continue;
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
  return res.status(200).json({ trade, grade });
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
