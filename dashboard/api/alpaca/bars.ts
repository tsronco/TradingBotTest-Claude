import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  const timeframe = String(req.query.timeframe ?? '1Day');
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 90));
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }
  try {
    const bars = await alpacaFor(mode).getStocksBars({ symbols: symbol, timeframe, limit });
    return res.status(200).json({ symbol, timeframe, bars });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
