import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from './_lib/kv.js';
import { isAllowedBotStateKey, lastUpdateKey } from './_lib/kv-keys.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const auth = req.headers.authorization ?? '';
  const expected = `Bearer ${process.env.BOT_PUSH_TOKEN ?? ''}`;
  if (!process.env.BOT_PUSH_TOKEN || auth !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body as { key?: string; payload?: unknown } | undefined;
  if (!body || typeof body.key !== 'string' || !isAllowedBotStateKey(body.key)) {
    return res.status(400).json({ error: 'invalid_or_unknown_key' });
  }
  if (body.payload === undefined || body.payload === null) {
    return res.status(400).json({ error: 'missing_payload' });
  }

  const k = body.key;
  await kv().set(k, body.payload);
  await kv().set(lastUpdateKey(k), new Date().toISOString());

  return res.status(200).json({ ok: true });
}
