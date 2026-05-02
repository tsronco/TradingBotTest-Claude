import { describe, it, expect, beforeEach, vi } from 'vitest';
import handler from '../../api/bot-state';
import * as kvModule from '../../api/_lib/kv';

const kvSet = vi.fn();
beforeEach(() => {
  kvSet.mockReset();
  vi.spyOn(kvModule, 'kv').mockReturnValue({ set: kvSet } as any);
  process.env.BOT_PUSH_TOKEN = 'test-token-123';
});

function makeReqRes(opts: {
  method?: string;
  auth?: string;
  body?: any;
}) {
  const req: any = {
    method: opts.method ?? 'POST',
    headers: { authorization: opts.auth, 'content-type': 'application/json' },
    body: opts.body,
  };
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
    end() { return this; },
  };
  return { req, res };
}

describe('POST /api/bot-state', () => {
  it('returns 405 on GET', async () => {
    const { req, res } = makeReqRes({ method: 'GET' });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 with no bearer token', async () => {
    const { req, res } = makeReqRes({ body: { key: 'bot:state:conservative', payload: {} } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('returns 401 with the wrong bearer token', async () => {
    const { req, res } = makeReqRes({ auth: 'Bearer wrong', body: { key: 'bot:state:conservative', payload: {} } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('returns 400 on a key not in the whitelist', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer test-token-123',
      body: { key: 'bot:state:made-up', payload: { x: 1 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('returns 400 on missing payload', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer test-token-123',
      body: { key: 'bot:state:conservative' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('writes payload + last-update timestamp on a valid request', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer test-token-123',
      body: { key: 'bot:state:conservative', payload: { hello: 'world' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(kvSet).toHaveBeenCalledWith('bot:state:conservative', { hello: 'world' });
    expect(kvSet).toHaveBeenCalledWith(
      'bot:last-update:bot:state:conservative',
      expect.any(String)
    );
  });
});
