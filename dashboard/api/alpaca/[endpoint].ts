import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard.js';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca.js';
import { alpacaData, alpacaTrade, alpacaTradeMutation } from '../_lib/data-api.js';
import { kv } from '../_lib/kv.js';
import { KV_KEYS, tradeKey } from '../_lib/kv-keys.js';

type OptionContract = {
  symbol: string;
  expiration_date: string;
  strike_price: string;
  type: 'call' | 'put';
  // Returned by /v2/options/contracts but missing from /v1beta1/options/snapshots,
  // so we thread it through manually below.
  open_interest?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const isMutation = ['modify-order', 'cancel-order'].includes(String(req.query.endpoint ?? ''));
  if (req.method !== 'GET' && !isMutation) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const endpoint = String(req.query.endpoint ?? '');
  const mode = modeFromQuery(req.query.mode);
  const client = alpacaFor(mode);

  try {
    if (endpoint === 'account') {
      const account = await client.getAccount();
      return res.status(200).json({ mode, account });
    }
    if (endpoint === 'positions') {
      const positions = await client.getPositions();
      return res.status(200).json({ mode, positions });
    }
    if (endpoint === 'orders') {
      const statusRaw = (Array.isArray(req.query.status) ? req.query.status[0] : req.query.status) ?? 'all';
      const status = ['open', 'closed', 'all'].includes(statusRaw as string)
        ? (statusRaw as 'open' | 'closed' | 'all')
        : 'all';
      const orders = await client.getOrders({ status, limit: 100, direction: 'desc' });
      return res.status(200).json({ mode, status, orders });
    }
    if (endpoint === 'quote') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const kind = String(req.query.kind ?? 'stock');

      if (kind === 'option') {
        if (!/^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(symbol)) {
          return res.status(400).json({ error: 'invalid_option_symbol' });
        }
        const snap = await alpacaData(mode, '/v1beta1/options/snapshots', { symbols: symbol });
        return res.status(200).json({ mode, symbol, snapshot: snap });
      }

      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const snap = await alpacaData(mode, '/v2/stocks/snapshots', { symbols: symbol });
      return res.status(200).json({ mode, symbol, snapshot: snap });
    }
    if (endpoint === 'chain') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const expiration = req.query.expiration ? String(req.query.expiration) : undefined;
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }

      // Bypass the SDK and paginate ourselves. Three reasons:
      //   1. SDK's `getOptionsContracts` returns `OptionsContract[]` directly — it
      //      strips `next_page_token` from the response, so callers can't paginate.
      //   2. Without an explicit limit, Alpaca returns ~100 contracts/page, which on
      //      a liquid underlying like TSLA is exactly one expiration. The dashboard
      //      needs all expirations to populate the dropdown.
      //   3. `status=active` alone returns ONLY ~3 nearest expirations on TSLA
      //      (~600 contracts). Adding `expiration_date_gte=today` widens the
      //      response to the full forward chain — 25+ expirations, weeklies +
      //      monthlies + LEAPS through 2028. Confirmed via direct curl 2026-05-02.
      // With limit=10000 even TSLA's full forward chain (~5700 contracts) fits in
      // a single page, but we still loop on next_page_token in case that changes.
      const today = new Date().toISOString().slice(0, 10);
      const allContracts: OptionContract[] = [];
      let pageToken: string | undefined = undefined;
      let pageCount = 0;
      const MAX_PAGES = 5; // safety cap — should never need this many

      do {
        const resp = await alpacaTrade<{
          option_contracts?: OptionContract[];
          next_page_token?: string;
        }>(mode, '/v2/options/contracts', {
          underlying_symbols: symbol,
          status: 'active',
          limit: 10000,
          expiration_date: expiration,
          expiration_date_gte: expiration ? undefined : today,
          page_token: pageToken,
        });
        if (Array.isArray(resp.option_contracts)) {
          allContracts.push(...resp.option_contracts);
        }
        pageToken = resp.next_page_token || undefined;
        pageCount++;
      } while (pageToken && pageCount < MAX_PAGES);

      if (allContracts.length === 0) {
        return res.status(200).json({ mode, symbol, expiration, contracts: [], snapshots: {} });
      }

      // Two-mode operation:
      //   - No `expiration` param: caller wants the dropdown of all expirations.
      //     Skip snapshots entirely (cheap fetch, big payload of contracts only).
      //   - With `expiration` param: caller picked an expiration and wants live
      //     quotes for it. The contracts query above already filtered to that
      //     expiration via `expiration_date`, so we snapshot all of them.
      //
      // Snapshots still get chunked at 100/request (Alpaca's hard cap; HTTP 400
      // "symbol limit is 100" above that). A single expiration on a liquid name
      // like INTC has 218 contracts → 3 chunks. Chunks run sequentially to keep
      // the request count bounded on the data-API rate limit. A single chunk
      // failing (transient 5xx) leaves other chunks' data intact rather than
      // blanking the whole chain.
      const snapshots: Record<string, Record<string, unknown>> = {};
      if (expiration) {
        const SNAPSHOT_CHUNK = 100;
        const targets = allContracts.map((c) => c.symbol);
        for (let i = 0; i < targets.length; i += SNAPSHOT_CHUNK) {
          const chunk = targets.slice(i, i + SNAPSHOT_CHUNK);
          try {
            const snapResp = await alpacaData<{ snapshots?: Record<string, Record<string, unknown>> }>(
              mode,
              '/v1beta1/options/snapshots',
              { symbols: chunk.join(',') }
            );
            Object.assign(snapshots, snapResp.snapshots ?? {});
          } catch (err) {
            console.error(`[chain] snapshot chunk ${i}-${i + chunk.length} failed for ${symbol} ${expiration}:`, err);
          }
        }
        // Merge open_interest from /v2/options/contracts into snapshots — Alpaca's
        // /v1beta1/options/snapshots doesn't include OI, but we already have the
        // contract metadata in hand, so this is free.
        for (const c of allContracts) {
          if (c.open_interest != null) {
            (snapshots[c.symbol] ??= {}).openInterest = Number(c.open_interest);
          }
        }
      }

      return res.status(200).json({
        mode, symbol, expiration,
        contracts: allContracts,
        snapshots,
      });
    }
    if (endpoint === 'news') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const newsResp = await alpacaData<{ news?: unknown[] }>(mode, '/v1beta1/news', { symbols: symbol, limit });
      return res.status(200).json({ symbol, news: newsResp.news ?? [] });
    }
    if (endpoint === 'equity-history') {
      // Default: last 30 calendar days at 1H granularity. Caller can override.
      const period = String(req.query.period ?? '1M');
      const timeframe = String(req.query.timeframe ?? '1H');
      const history = await alpacaTrade<{
        timestamp?: number[];
        equity?: number[];
        profit_loss?: number[];
        profit_loss_pct?: number[];
        base_value?: number;
      }>(mode, '/v2/account/portfolio/history', {
        period,
        timeframe,
        intraday_reporting: 'market_hours',
      });
      return res.status(200).json({ mode, period, timeframe, history });
    }
    if (endpoint === 'bars') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const timeframe = String(req.query.timeframe ?? '1Day');
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 90));
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      // Alpaca returns bars:null when no start/end is given. Default to a window
      // ~2x the requested limit (calendar days) so we comfortably cover the bar count
      // even for daily timeframes that skip weekends.
      const startParam = req.query.start ? String(req.query.start) : undefined;
      const endParam = req.query.end ? String(req.query.end) : undefined;
      const start = startParam
        ?? new Date(Date.now() - limit * 2 * 86400000).toISOString().slice(0, 10);
      const bars = await alpacaData(mode, `/v2/stocks/${symbol}/bars`, {
        timeframe, limit, start, end: endParam, feed: 'iex',
      });
      return res.status(200).json({ symbol, timeframe, bars });
    }
    if (endpoint === 'modify-order' && req.method === 'POST') {
      const body = (req.body ?? {}) as { order_id?: string; qty?: number; limit_price?: number; stop_price?: number; tif?: string };
      if (!body.order_id) return res.status(400).json({ error: 'order_id_required' });
      const patch: Record<string, unknown> = {};
      if (body.qty != null) patch.qty = body.qty;
      if (body.limit_price != null) patch.limit_price = body.limit_price;
      if (body.stop_price != null) patch.stop_price = body.stop_price;
      if (body.tif) patch.time_in_force = body.tif;
      const updated = await alpacaTradeMutation(mode, `/v2/orders/${body.order_id}`, { method: 'PATCH', body: patch });
      return res.status(200).json({ order: updated });
    }
    if (endpoint === 'cancel-order' && req.method === 'POST') {
      const body = (req.body ?? {}) as { order_id?: string };
      if (!body.order_id) return res.status(400).json({ error: 'order_id_required' });

      // 1) Cancel on Alpaca
      await alpacaTradeMutation(mode, `/v2/orders/${body.order_id}`, { method: 'DELETE' });

      // 2) Find a matching trade record in trades:index:open and close it as 'canceled'
      // (only if it hasn't filled yet — filled trades use the normal close-order flow)
      const openIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];
      for (const id of openIds) {
        const trade = await kv().get<any>(tradeKey(id));
        if (!trade || trade.alpaca_order_id !== body.order_id) continue;
        if (trade.filled_at) continue; // already filled — let the normal close-order flow handle it
        const updated = {
          ...trade,
          closed_at: new Date().toISOString(),
          closed_avg_price: 0,
          realized_pnl: 0,
          closed_by: 'canceled',
        };
        await kv().set(tradeKey(id), updated);
        await kv().lrem(KV_KEYS.tradesIndexOpen, 0, id);
        break;
      }

      return res.status(200).json({ ok: true });
    }
    return res.status(404).json({ error: 'unknown_endpoint' });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
