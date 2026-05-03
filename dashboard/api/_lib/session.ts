import { createHmac, timingSafeEqual } from 'node:crypto';
import { serialize as cookieSerialize } from 'cookie';

export interface Session {
  sub: string;          // user identifier (always "tim" for this single-user app)
  loggedInAt: number;   // unix seconds
}

export const SESSION_COOKIE_NAME = 'dash_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;   // 30 days

function sign(input: string): string {
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret) throw new Error('SESSION_SECRET not set');
  return createHmac('sha256', secret).update(input).digest('hex');
}

export function encodeSession(session: Session): string {
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  const sig = sign(body);
  return `${body}.${sig}`;
}

export function decodeSession(token: string): Session | null {
  if (!token || typeof token !== 'string') return null;
  if (!process.env.SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
  } catch {
    return null;
  }
}

export function serializeSessionCookie(
  value: string,
  opts: { secure: boolean }
): string {
  return cookieSerialize(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  return cookieSerialize(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}
