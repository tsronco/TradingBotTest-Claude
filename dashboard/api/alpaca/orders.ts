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
  const statusRaw = (Array.isArray(req.query.status) ? req.query.status[0] : req.query.status) ?? 'all';
  const status = ['open', 'closed', 'all'].includes(statusRaw as string)
    ? (statusRaw as 'open' | 'closed' | 'all')
    : 'all';
  try {
    const orders = await alpacaFor(mode).getOrders({ status, limit: 100, direction: 'desc' });
    return res.status(200).json({ mode, status, orders });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
