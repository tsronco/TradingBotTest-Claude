import { describe, it, expect, beforeEach } from 'vitest';
import { authenticator } from 'otplib';
import handler from '../../api/auth/login';

const secret = authenticator.generateSecret();

beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = 'correct-horse-battery-staple';
  process.env.TOTP_SECRET = secret;
  process.env.SESSION_SECRET = 'a'.repeat(64);
});

function makeReqRes(body: any, method = 'POST') {
  const req: any = {
    method,
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
