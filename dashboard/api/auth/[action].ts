import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyTotp } from '../_lib/totp.js';
import { encodeSession, serializeSessionCookie, clearSessionCookie } from '../_lib/session.js';
import { isRateLimited, recordFailure, clearFailures, clientIp } from '../_lib/rate-limit.js';
import { looksLikeBackupCode, consumeBackupCodeIfValid } from '../_lib/backup-codes.js';
import { getSession } from '../_lib/auth-guard.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = String(req.query.action ?? '');
  if (action === 'login') return handleLogin(req, res);
  if (action === 'logout') return handleLogout(req, res);
  if (action === 'session') return handleSession(req, res);
  return res.status(404).json({ error: 'unknown_action' });
}

async function handleLogin(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ip = clientIp(req.headers as any);

  // CHANGE: rate-limit check up front
  if (await isRateLimited(ip)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const { password, totp } = (req.body ?? {}) as {
    password?: string;
    totp?: string;
  };

  if (!password || !totp) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const expectedPassword = process.env.DASHBOARD_PASSWORD ?? '';
  const totpSecret = process.env.TOTP_SECRET ?? '';

  if (!expectedPassword || password !== expectedPassword) {
    await recordFailure(ip);                                // CHANGE
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  // CHANGE: accept either a TOTP code OR a backup code
  let secondFactorOk = false;
  if (looksLikeBackupCode(totp)) {
    secondFactorOk = await consumeBackupCodeIfValid(totp);
  } else {
    secondFactorOk = verifyTotp(totp, totpSecret);
  }
  if (!secondFactorOk) {
    await recordFailure(ip);                                // CHANGE
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  await clearFailures(ip);                                  // CHANGE
  const token = encodeSession({ sub: 'tim', loggedInAt: Math.floor(Date.now() / 1000) });
  const isProd = process.env.VERCEL_ENV === 'production';
  res.setHeader('Set-Cookie', serializeSessionCookie(token, { secure: isProd }));
  return res.status(200).json({ ok: true });
}

async function handleLogout(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const isProd = process.env.VERCEL_ENV === 'production';
  res.setHeader('Set-Cookie', clearSessionCookie({ secure: isProd }));
  return res.status(200).json({ ok: true });
}

async function handleSession(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = getSession(req);
  if (!session) return res.status(200).json({ authenticated: false });
  return res.status(200).json({ authenticated: true, session });
}
