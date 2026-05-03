import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }
  try {
    const snap = await alpacaFor(mode).getStocksSnapshots({ symbols: symbol });
    return res.status(200).json({ mode, symbol, snapshot: snap });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
