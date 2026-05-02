import type { VercelRequest, VercelResponse } from '@vercel/node';
import { clearSessionCookie } from '../_lib/session';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const isProd = process.env.VERCEL_ENV === 'production';
  res.setHeader('Set-Cookie', clearSessionCookie({ secure: isProd }));
  return res.status(200).json({ ok: true });
}
