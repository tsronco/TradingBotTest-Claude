import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard.js';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca.js';

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
      const snap = await client.getStocksSnapshots({ symbols: symbol });
      return res.status(200).json({ mode, symbol, snapshot: snap });
    }
    if (endpoint === 'chain') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const expiration = req.query.expiration ? String(req.query.expiration) : undefined;
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const contracts = await client.getOptionsContracts({
        underlying_symbols: symbol,
        ...(expiration ? { expiration_date: expiration } : {}),
        limit: 200,
      });
      const ids = (contracts as any).option_contracts?.map((c: any) => c.symbol) ?? [];
      if (ids.length === 0) {
        return res.status(200).json({ mode, symbol, expiration, contracts: [] });
      }
      // Snapshots gives us bid/ask + Greeks (delta, gamma, theta, vega) + IV.
      const snapshots = await client.getOptionsSnapshots({ symbols: ids.join(',') });
      return res.status(200).json({
        mode,
        symbol,
        expiration,
        contracts: (contracts as any).option_contracts ?? [],
        snapshots,
      });
    }
    if (endpoint === 'news') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const news = await client.getNews({ symbols: symbol, limit });
      return res.status(200).json({ symbol, news });
    }
    if (endpoint === 'bars') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const timeframe = String(req.query.timeframe ?? '1Day');
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 90));
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const bars = await client.getStocksBars({ symbols: symbol, timeframe, limit });
      return res.status(200).json({ symbol, timeframe, bars });
    }
    return res.status(404).json({ error: 'unknown_endpoint' });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
