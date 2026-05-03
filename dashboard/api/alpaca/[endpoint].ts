import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard.js';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca.js';
import { alpacaData } from '../_lib/data-api.js';

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
      // Options *contracts* live on the trading endpoint, so the SDK works fine here.
      // Only the *snapshots* call needs to bypass the SDK (data endpoint, hits the bug).
      const contractsResp = await client.getOptionsContracts({
        underlying_symbols: symbol,
        ...(expiration ? { expiration_date: expiration } : {}),
        limit: 200,
      });
      const contracts = (contractsResp as any).option_contracts ?? [];
      if (contracts.length === 0) {
        return res.status(200).json({ mode, symbol, expiration, contracts: [], snapshots: {} });
      }
      const ids = contracts.map((c: { symbol: string }) => c.symbol).join(',');
      const snapResp = await alpacaData<{ snapshots?: Record<string, unknown> }>(
        mode,
        '/v1beta1/options/snapshots',
        { symbols: ids }
      );
      return res.status(200).json({
        mode, symbol, expiration,
        contracts,
        snapshots: snapResp.snapshots ?? {},
      });
    }
    if (endpoint === 'news') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const news = await alpacaData(mode, '/v1beta1/news', { symbols: symbol, limit });
      return res.status(200).json({ symbol, news });
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
