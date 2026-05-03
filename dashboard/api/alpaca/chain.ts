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
  const expiration = req.query.expiration ? String(req.query.expiration) : undefined;
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }
  try {
    const client = alpacaFor(mode);
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
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
