import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession } from '../_lib/auth-guard';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = getSession(req);
  if (!session) return res.status(200).json({ authenticated: false });
  return res.status(200).json({ authenticated: true, session });
}
