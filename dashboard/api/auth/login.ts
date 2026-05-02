import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyTotp } from '../_lib/totp';
import { encodeSession, serializeSessionCookie } from '../_lib/session';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
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
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (!verifyTotp(totp, totpSecret)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const token = encodeSession({ sub: 'tim', loggedInAt: Math.floor(Date.now() / 1000) });
  const isProd = process.env.VERCEL_ENV === 'production';
  res.setHeader('Set-Cookie', serializeSessionCookie(token, { secure: isProd }));
  return res.status(200).json({ ok: true });
}
