import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard.js';
import { getJson, setJson } from '../_lib/kv.js';
import { isAllowedBotStateKey, lastUpdateKey, KV_KEYS } from '../_lib/kv-keys.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  const resource = String(req.query.resource ?? '');
  if (resource === 'bot-state') return handleBotState(req, res);
  if (resource === 'watchlist') return handleWatchlist(req, res);
  return res.status(404).json({ error: 'unknown_resource' });
}

async function handleBotState(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  const key = String(req.query.key ?? '');
  if (!isAllowedBotStateKey(key)) {
    return res.status(400).json({ error: 'invalid_key' });
  }
  const [payload, lastUpdate] = await Promise.all([
    getJson(key),
    getJson<string>(lastUpdateKey(key)),
  ]);
  return res.status(200).json({ key, payload, lastUpdate });
}

async function handleWatchlist(req: VercelRequest, res: VercelResponse) {
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
