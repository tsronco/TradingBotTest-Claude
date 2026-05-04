// dashboard/api/settings/[resource].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { requireAuth } from '../_lib/auth-guard.js';
import { KV_KEYS } from '../_lib/kv-keys.js';
import { regenerateBackupCodes } from '../_lib/backup-codes.js';
import { verifyTotp } from '../_lib/totp.js';

const SEED_TAGS = [
  'breakout', 'morning_setup', 'pullback', 'earnings_play',
  'wheel', 'wheel_50pct', 'delta_target', 'sized_down',
  'scale_in', 'trim', 'stop_hit',
];

const DEFAULT_THRESHOLDS = {
  conservative_paper: 5000,
  aggressive_paper: 10000,
  live: 1500,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  const resource = String(req.query.resource ?? '');

  if (resource === 'thresholds') return handleThresholds(req, res);
  if (resource === 'tags') return handleTags(req, res);
  if (resource === 'backup-codes') return handleBackupCodes(req, res);
  return res.status(404).json({ error: 'unknown_resource' });
}

async function handleThresholds(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const stored = (await kv().get<typeof DEFAULT_THRESHOLDS>(KV_KEYS.totpThresholds)) ?? DEFAULT_THRESHOLDS;
    return res.status(200).json({ thresholds: stored });
  }
  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Partial<typeof DEFAULT_THRESHOLDS>;
    const cons = Number(body.conservative_paper);
    const agg = Number(body.aggressive_paper);
    const live = Number(body.live);
    if (![cons, agg, live].every((n) => Number.isFinite(n) && n >= 0)) {
      return res.status(400).json({ error: 'invalid_threshold_values' });
    }
    const thresholds = { conservative_paper: cons, aggressive_paper: agg, live };
    await kv().set(KV_KEYS.totpThresholds, thresholds);
    return res.status(200).json({ ok: true, thresholds });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleTags(req: VercelRequest, res: VercelResponse) {
  const list = (await kv().get<string[]>(KV_KEYS.tagsList)) ?? SEED_TAGS;

  if (req.method === 'GET') return res.status(200).json({ tags: list });

  if (req.method === 'POST') {
    const tag = String((req.body as { tag?: string } | undefined)?.tag ?? '').trim().toLowerCase();
    if (!tag || !/^[a-z0-9_]+$/.test(tag)) {
      return res.status(400).json({ error: 'invalid_tag' });
    }
    if (list.includes(tag)) return res.status(200).json({ ok: true, tags: list });
    const next = [...list, tag];
    await kv().set(KV_KEYS.tagsList, next);
    return res.status(200).json({ ok: true, tags: next });
  }

  if (req.method === 'DELETE') {
    const tag = String((req.body as { tag?: string } | undefined)?.tag ?? '').trim().toLowerCase();
    const next = list.filter((t) => t !== tag);
    await kv().set(KV_KEYS.tagsList, next);
    return res.status(200).json({ ok: true, tags: next });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleBackupCodes(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const body = (req.body ?? {}) as { totp_code?: string };
  const code = String(body.totp_code ?? '').trim();
  if (!code || !verifyTotp(code, process.env.TOTP_SECRET ?? '')) {
    return res.status(401).json({ error: 'invalid_totp' });
  }
  const { codes } = await regenerateBackupCodes();
  return res.status(200).json({ codes, regenerated_at: new Date().toISOString() });
}
