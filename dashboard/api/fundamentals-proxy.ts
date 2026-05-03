import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from './_lib/auth-guard';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const symbol = String(req.query.symbol ?? '');
  // Vercel routes /api/fundamentals.py as /api/fundamentals — call it server-to-server.
  const url = `https://${req.headers.host}/api/fundamentals?symbol=${encodeURIComponent(symbol)}`;
  const resp = await fetch(url);
  res.setHeader('Content-Type', 'application/json');
  res.status(resp.status);
  res.send(await resp.text());
}
