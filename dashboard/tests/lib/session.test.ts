import { describe, it, expect, beforeEach } from 'vitest';
import {
  encodeSession,
  decodeSession,
  serializeSessionCookie,
  type Session,
} from '../../api/_lib/session';

beforeEach(() => {
  process.env.SESSION_SECRET = 'a'.repeat(64);
});

describe('encode/decode session', () => {
  const sample: Session = { sub: 'tim', loggedInAt: 1700000000 };

  it('round-trips a valid session', () => {
    const token = encodeSession(sample);
    const out = decodeSession(token);
    expect(out).toEqual(sample);
  });

  it('rejects a tampered token', () => {
    const token = encodeSession(sample);
    const [body] = token.split('.');
    const tampered = `${body}.deadbeef`;
    expect(decodeSession(tampered)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(decodeSession('not-a-token')).toBeNull();
    expect(decodeSession('')).toBeNull();
  });

  it('rejects when SESSION_SECRET is missing', () => {
    process.env.SESSION_SECRET = '';
    const token = 'ignored.ignored';
    expect(decodeSession(token)).toBeNull();
  });
});

describe('serializeSessionCookie', () => {
  it('emits HttpOnly + Secure + SameSite=Strict', () => {
    const cookie = serializeSessionCookie('value-here', { secure: true });
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);   // 30 days
  });

  it('omits Secure flag in non-secure mode (for local dev)', () => {
    const cookie = serializeSessionCookie('v', { secure: false });
    expect(cookie).not.toMatch(/Secure/);
  });
});
