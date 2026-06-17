import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authenticator } from 'otplib';
import handler from '../../api/auth/[action]';
import * as rateLimit from '../../api/_lib/rate-limit';

vi.spyOn(rateLimit, 'isRateLimited').mockResolvedValue(false);
vi.spyOn(rateLimit, 'recordFailure').mockResolvedValue();
vi.spyOn(rateLimit, 'clearFailures').mockResolvedValue();

const secret = authenticator.generateSecret();

beforeEach(() => {
  vi.stubEnv('DASHBOARD_PASSWORD', 'correct-horse-battery-staple');
  vi.stubEnv('TOTP_SECRET', secret);
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(64));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeReqRes(body: any, method = 'POST') {
  const req: any = {
    method,
    query: { action: 'login' },
    headers: { 'content-type': 'application/json' },
    body,
  };
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string | string[]>,
    setHeader(k: string, v: string | string[]) { this.headers[k] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: any) { this.body = p; return this; },
    end() { return this; },
  };
  return { req, res };
}

describe('POST /api/auth/login', () => {
  it('returns 405 on GET', async () => {
    const { req, res } = makeReqRes({}, 'GET');
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects wrong password', async () => {
    const { req, res } = makeReqRes({
      password: 'wrong',
      totp: authenticator.generate(secret),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('rejects wrong TOTP', async () => {
    const { req, res } = makeReqRes({
      password: 'correct-horse-battery-staple',
      totp: '000000',
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing fields', async () => {
    const { req, res } = makeReqRes({ password: 'correct-horse-battery-staple' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('sets a session cookie on valid password + TOTP', async () => {
    const { req, res } = makeReqRes({
      password: 'correct-horse-battery-staple',
      totp: authenticator.generate(secret),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['Set-Cookie'];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toMatch(/dash_session=/);
    expect(String(setCookie)).toMatch(/HttpOnly/);
  });
});

describe('rate limiting', () => {
  it('returns 429 when isRateLimited returns true', async () => {
    (rateLimit.isRateLimited as any).mockResolvedValueOnce(true);
    const { req, res } = makeReqRes({
      password: 'correct-horse-battery-staple',
      totp: authenticator.generate(secret),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(429);
  });
});

import { generateBackupCode } from '../../api/_lib/backup-codes';
import * as kvModule from '../../api/_lib/kv';

describe('backup code login', () => {
  it('accepts an unused backup code in place of TOTP', async () => {
    const { code, hash } = generateBackupCode();
    vi.stubEnv('BACKUP_CODES_HASHED', hash);

    const kvGet = vi.fn().mockResolvedValue(null);
    const kvSet = vi.fn().mockResolvedValue(undefined);
    // sadd returns 1 = newly added (first use of this code) — atomic consumption path.
    const kvSadd = vi.fn().mockResolvedValue(1);
    vi.spyOn(kvModule, 'kv').mockReturnValue({ get: kvGet, set: kvSet, del: vi.fn(), sadd: kvSadd } as any);

    const { req, res } = makeReqRes({
      password: 'correct-horse-battery-staple',
      totp: code,
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
