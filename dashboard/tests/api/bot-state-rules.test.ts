import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../../api/bot-state';
import * as kvModule from '../../api/_lib/kv';

const kvSet = vi.fn();
beforeEach(() => {
  kvSet.mockReset();
  kvSet.mockResolvedValue('OK');
  vi.spyOn(kvModule, 'kv').mockReturnValue({ set: kvSet } as any);
  vi.stubEnv('BOT_PUSH_TOKEN', 'test-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeReqRes(opts: { method?: string; auth?: string; body?: any }) {
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

function mkRulesPayload(mode: 'manual' | 'live') {
  return {
    mode,
    wheel: {
      symbols: ['TSLA'],
      otm_pct: 0.10,
      dte_min: 14,
      dte_max: 28,
      close_at_profit_pct: 0.50,
    },
    strategy: {
      underlying: 'TSLA',
      initial_qty: 10,
      stop_loss_pct: 0.10,
      trail_activate_pct: 0.10,
      trail_floor_pct: 0.05,
      ladders: [],
    },
    pushed_at: '2026-05-07T13:00:00Z',
  };
}

describe('POST /api/bot-state — bot:rules:* push', () => {
  it.each(['manual', 'live'] as const)(
    'accepts bot:rules:%s push and writes to KV',
    async (mode) => {
      const { req, res } = makeReqRes({
        auth: 'Bearer test-token',
        body: { key: `bot:rules:${mode}`, payload: mkRulesPayload(mode) },
      });
      await handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(kvSet).toHaveBeenCalledWith(
        `bot:rules:${mode}`,
        expect.objectContaining({ mode }),
      );
      expect(kvSet).toHaveBeenCalledWith(
        `bot:last-update:bot:rules:${mode}`,
        expect.any(String),
      );
    },
  );

  it.each(['manual', 'live'] as const)(
    'accepts bot-state/strategy/rules push for %s and writes to KV',
    async (acct) => {
      for (const kind of ['state', 'strategy', 'rules'] as const) {
        kvSet.mockClear();
        const key = `bot:${kind}:${acct}`;
        const { req, res } = makeReqRes({
          auth: 'Bearer test-token',
          body: { key, payload: { acct } },
        });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(kvSet).toHaveBeenCalledWith(key, { acct });
        expect(kvSet).toHaveBeenCalledWith(
          `bot:last-update:${key}`,
          expect.any(String),
        );
      }
    },
  );

  it.each(['conservative', 'aggressive', 'sm500', 'sm1000', 'sm2000'] as const)(
    'rejects retired-account key bot:rules:%s with 400',
    async (acct) => {
      const { req, res } = makeReqRes({
        auth: 'Bearer test-token',
        body: { key: `bot:rules:${acct}`, payload: {} },
      });
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(kvSet).not.toHaveBeenCalled();
    },
  );

  it('rejects bot:rules:nonsense (key not in whitelist) with 400', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer test-token',
      body: { key: 'bot:rules:nonsense', payload: {} },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('rejects unauthorized push with 401', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer wrong-token',
      body: { key: 'bot:rules:manual', payload: mkRulesPayload('manual') },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('rejects missing payload with 400', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer test-token',
      body: { key: 'bot:rules:manual' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(kvSet).not.toHaveBeenCalled();
  });
});
