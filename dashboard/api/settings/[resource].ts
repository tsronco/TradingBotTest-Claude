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

// SM accounts behave like manual (hand-traded small accounts) — mirror manual's
// TOTP threshold ($2,500). Keep in sync with trades/[action].ts DEFAULT_THRESHOLDS.
const DEFAULT_THRESHOLDS = {
  conservative_paper: 5000,
  aggressive_paper: 10000,
  manual_paper: 2500,
  live: 1500,
  sm500_paper: 2500,
  sm1000_paper: 2500,
  sm2000_paper: 2500,
};

const DEFAULT_DISPLAY_NAME = 'trader';
const DISPLAY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,23}$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = String(req.query.resource ?? '');

  // display-name GET is public (the Login page reads it before auth); POST gates on auth below.
  if (resource === 'display-name') return handleDisplayName(req, res);

  if (!requireAuth(req, res)) return;

  if (resource === 'thresholds') return handleThresholds(req, res);
  if (resource === 'tags') return handleTags(req, res);
  if (resource === 'backup-codes') return handleBackupCodes(req, res);
  return res.status(404).json({ error: 'unknown_resource' });
}

async function handleDisplayName(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const name = (await kv().get<string>(KV_KEYS.displayName)) ?? DEFAULT_DISPLAY_NAME;
    return res.status(200).json({ display_name: name });
  }
  if (req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const raw = String((req.body as { display_name?: string } | undefined)?.display_name ?? '').trim();
    if (!DISPLAY_NAME_PATTERN.test(raw)) {
      return res.status(400).json({ error: 'invalid_display_name' });
    }
    await kv().set(KV_KEYS.displayName, raw);
    return res.status(200).json({ ok: true, display_name: raw });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
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
    const manual = Number(body.manual_paper);
    const live = Number(body.live);
    const sm500 = Number(body.sm500_paper);
    const sm1000 = Number(body.sm1000_paper);
    const sm2000 = Number(body.sm2000_paper);
    if (![cons, agg, manual, live, sm500, sm1000, sm2000].every((n) => Number.isFinite(n) && n >= 0)) {
      return res.status(400).json({ error: 'invalid_threshold_values' });
    }
    const thresholds = {
      conservative_paper: cons,
      aggressive_paper: agg,
      manual_paper: manual,
      live,
      sm500_paper: sm500,
      sm1000_paper: sm1000,
      sm2000_paper: sm2000,
    };
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
