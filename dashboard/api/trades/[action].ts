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

// stubs for the next tasks; written here to keep the file building
async function submit(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function list(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function getOne(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function regrade(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
