import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse as parseCookie } from 'cookie';
import { decodeSession, SESSION_COOKIE_NAME, type Session } from './session.js';

export function getSession(req: VercelRequest): Session | null {
  const raw = req.headers.cookie ?? '';
  if (!raw) return null;
  const parsed = parseCookie(raw);
  const token = parsed[SESSION_COOKIE_NAME];
  if (!token) return null;
  return decodeSession(token);
}

export function requireAuth(req: VercelRequest, res: VercelResponse): Session | null {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return session;
}
