import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  encodeSession,
  decodeSession,
  serializeSessionCookie,
  type Session,
} from '../../api/_lib/session';

const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days — must match session.ts

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(64));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('encode/decode session', () => {
  // Updated from the old hardcoded 1700000000 (Nov 2023, > 30 days ago) so
  // this sample stays valid after the D10 server-side age check was added.
  // We pin "now" via fake timers so the test is deterministic regardless of
  // when it runs.
  const NOW_SECONDS = 1_750_000_000; // ~2025-06-15, well within any real run window
  const sample: Session = { sub: 'tim', loggedInAt: NOW_SECONDS };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

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
    vi.stubEnv('SESSION_SECRET', '');
    const token = 'ignored.ignored';
    expect(decodeSession(token)).toBeNull();
  });
});

// ── D10: server-side session age check ────────────────────────────────────────
// decodeSession must reject any validly-signed token whose loggedInAt is older
// than MAX_AGE_SECONDS, regardless of the browser cookie's maxAge attribute.
// Comparison is strict: age > MAX_AGE_SECONDS (so exactly-at-boundary is valid).
describe('D10 — server-side session expiry', () => {
  const NOW_SECONDS = 1_750_000_000; // arbitrary but stable epoch

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  it('rejects a validly-signed token that is older than MAX_AGE_SECONDS', () => {
    // loggedInAt = one second past the max age ago → must be null
    const expired: Session = {
      sub: 'tim',
      loggedInAt: NOW_SECONDS - MAX_AGE_SECONDS - 1,
    };
    const token = encodeSession(expired);
    expect(decodeSession(token)).toBeNull();
  });

  it('accepts a fresh token (loggedInAt = now)', () => {
    const fresh: Session = { sub: 'tim', loggedInAt: NOW_SECONDS };
    const token = encodeSession(fresh);
    expect(decodeSession(token)).toEqual(fresh);
  });

  it('accepts a token issued just inside the boundary (age = MAX_AGE_SECONDS)', () => {
    // age == MAX_AGE_SECONDS is NOT expired (we use strict >)
    const atBoundary: Session = {
      sub: 'tim',
      loggedInAt: NOW_SECONDS - MAX_AGE_SECONDS,
    };
    const token = encodeSession(atBoundary);
    expect(decodeSession(token)).toEqual(atBoundary);
  });

  it('rejects a token that is exactly one second past the boundary', () => {
    const oneOver: Session = {
      sub: 'tim',
      loggedInAt: NOW_SECONDS - MAX_AGE_SECONDS - 1,
    };
    const token = encodeSession(oneOver);
    expect(decodeSession(token)).toBeNull();
  });

  it('still rejects a tampered (bad-signature) expired token', () => {
    const expired: Session = {
      sub: 'tim',
      loggedInAt: NOW_SECONDS - MAX_AGE_SECONDS - 100,
    };
    const token = encodeSession(expired);
    const [body] = token.split('.');
    const tampered = `${body}.deadbeef`;
    expect(decodeSession(tampered)).toBeNull();
  });

  it('still rejects when SESSION_SECRET is missing (even for a fresh token)', () => {
    const fresh: Session = { sub: 'tim', loggedInAt: NOW_SECONDS };
    const token = encodeSession(fresh); // encode while secret is still set
    vi.stubEnv('SESSION_SECRET', '');   // now strip the secret
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
