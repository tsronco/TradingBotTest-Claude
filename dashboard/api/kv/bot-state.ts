import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { getJson } from '../_lib/kv';
import { isAllowedBotStateKey, lastUpdateKey } from '../_lib/kv-keys';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!requireAuth(req, res)) return;
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
