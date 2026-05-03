import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { getJson, setJson } from '../_lib/kv';
import { KV_KEYS } from '../_lib/kv-keys';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    const list = (await getJson<string[]>(KV_KEYS.watchlist)) ?? [];
    return res.status(200).json({ watchlist: list });
  }

  if (req.method === 'POST') {
    const symbol = String((req.body as any)?.symbol ?? '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
      return res.status(400).json({ error: 'invalid_symbol' });
    }
    const list = new Set((await getJson<string[]>(KV_KEYS.watchlist)) ?? []);
    list.add(symbol);
    const next = [...list].sort();
    await setJson(KV_KEYS.watchlist, next);
    return res.status(200).json({ watchlist: next });
  }

  if (req.method === 'DELETE') {
    const symbol = String((req.body as any)?.symbol ?? '').toUpperCase();
    const list = ((await getJson<string[]>(KV_KEYS.watchlist)) ?? []).filter((s) => s !== symbol);
    await setJson(KV_KEYS.watchlist, list);
    return res.status(200).json({ watchlist: list });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).end();
}
