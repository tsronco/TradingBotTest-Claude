import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }
  try {
    const news = await alpacaFor(mode).getNews({ symbols: symbol, limit });
    return res.status(200).json({ symbol, news });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
