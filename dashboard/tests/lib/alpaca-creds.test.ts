/**
 * Credential resolution per account.
 *
 * The failure this guards against is real and was hit in production: the agent
 * account's keys were set as GitHub Actions secrets (which the bot reads) but
 * not as Vercel env vars (which the dashboard reads), and the dashboard showed
 * only "failed to load Agent" with no hint as to why.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CRED_ENV_VARS, MissingCredentialsError, isMode, isPaperMode } from '../../api/_lib/alpaca';
import { alpacaTrade } from '../../api/_lib/data-api';

const ALL_CRED_VARS = Object.values(CRED_ENV_VARS).flatMap((v) => [v.key, v.secret]);

describe('CRED_ENV_VARS', () => {
  it('gives every account its own distinct credential pair', () => {
    expect(new Set(ALL_CRED_VARS).size).toBe(ALL_CRED_VARS.length);
  });

  it('maps each account to the documented variable names', () => {
    expect(CRED_ENV_VARS.manual).toEqual({
      key: 'ALPACA_MANUAL_API_KEY', secret: 'ALPACA_MANUAL_API_SECRET',
    });
    expect(CRED_ENV_VARS.live).toEqual({
      key: 'ALPACA_LIVE_API_KEY', secret: 'ALPACA_LIVE_API_SECRET',
    });
    expect(CRED_ENV_VARS.agent).toEqual({
      key: 'ALPACA_AGENT_API_KEY', secret: 'ALPACA_AGENT_API_SECRET',
    });
  });

  it('never routes the agent account at live credentials', () => {
    expect(CRED_ENV_VARS.agent.key).not.toBe(CRED_ENV_VARS.live.key);
    expect(isPaperMode('agent')).toBe(true);
    expect(isMode('agent')).toBe(true);
  });
});

describe('missing credentials', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of ALL_CRED_VARS) { saved[v] = process.env[v]; delete process.env[v]; }
  });
  afterEach(() => {
    for (const v of ALL_CRED_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('throws a typed error naming both missing variables', async () => {
    await expect(alpacaTrade('agent', '/v2/account')).rejects.toBeInstanceOf(MissingCredentialsError);
    await expect(alpacaTrade('agent', '/v2/account')).rejects.toMatchObject({
      mode: 'agent',
      missing: ['ALPACA_AGENT_API_KEY', 'ALPACA_AGENT_API_SECRET'],
    });
  });

  it('names only the variable that is actually absent', async () => {
    process.env.ALPACA_AGENT_API_KEY = 'PKtest';
    await expect(alpacaTrade('agent', '/v2/account')).rejects.toMatchObject({
      missing: ['ALPACA_AGENT_API_SECRET'],
    });
  });

  it('points at the Vercel environment, not GitHub Actions secrets', async () => {
    // The two stores share variable names, which is exactly why this bit them.
    const err = await alpacaTrade('agent', '/v2/account').catch((e) => e as Error);
    expect(err.message).toMatch(/Vercel/);
    expect(err.message).toMatch(/GitHub Actions secrets are a separate store/);
    expect(err.message).toMatch(/ALPACA_AGENT_API_KEY/);
  });

  it('treats an empty-string value as missing, not as a usable key', async () => {
    process.env.ALPACA_AGENT_API_KEY = '';
    process.env.ALPACA_AGENT_API_SECRET = '';
    await expect(alpacaTrade('agent', '/v2/account')).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it('reports per-account — a configured account is unaffected', async () => {
    process.env.ALPACA_MANUAL_API_KEY = 'PKtest';
    process.env.ALPACA_MANUAL_API_SECRET = 'sectest';
    await expect(alpacaTrade('agent', '/v2/account')).rejects.toMatchObject({ mode: 'agent' });
  });
});
