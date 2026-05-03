import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard.js';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca.js';
import { alpacaData, alpacaTrade } from '../_lib/data-api.js';

type OptionContract = {
  symbol: string;
  expiration_date: string;
  strike_price: string;
  type: 'call' | 'put';
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
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

      // Snapshots URL gets long fast on a 600-contract list. Cap at 250 — enough
      // to cover the visible strikes of any single expiration the UI is rendering.
      // If snapshots fail (off-hours, IEX gaps), still return the contracts so the
      // dropdown / strike filter remain useful.
      const symbolsForSnapshots = allContracts.slice(0, 250).map((c) => c.symbol).join(',');
      let snapshots: Record<string, unknown> = {};
      try {
        const snapResp = await alpacaData<{ snapshots?: Record<string, unknown> }>(
          mode,
          '/v1beta1/options/snapshots',
          { symbols: symbolsForSnapshots }
        );
        snapshots = snapResp.snapshots ?? {};
      } catch {
        snapshots = {};
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
    return res.status(404).json({ error: 'unknown_endpoint' });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
