// dashboard/tests/lib/ai-summary-cooldown.test.ts
//
// Tests for the per-symbol refresh cooldown in getOrCreateSummary.
// The cooldown prevents paid Claude calls from being spammed via the refresh
// button — a refresh within REFRESH_COOLDOWN_SECONDS of a prior one serves the
// cached summary instead of calling the Claude API.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---- KV mock (must be before any module import that touches kv) ----
const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet }),
}));

// ---- Anthropic SDK mock (tracks call count) ----
const claudeCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (...a: any[]) => claudeCreate(...a) };
  },
}));

// ---- data-api + fundamentals-fetch — return minimal stubs ----
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: vi.fn().mockResolvedValue({}),
  alpacaTrade: vi.fn().mockResolvedValue({ option_contracts: [] }),
}));
vi.mock('../../api/_lib/fundamentals-fetch', () => ({
  fetchEarningsDate: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockReset();
  claudeCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

// Minimal Claude response that extractText() can read as a non-empty string.
function stubbedClaudeResp() {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Stock is doing things.' }],
  };
}

describe('getOrCreateSummary — refresh cooldown', () => {
  it('a non-refresh request uses the 15-min cache and never calls Claude', async () => {
    const cached = { summary: 'cached text', generated_at: '2026-06-25T12:00:00Z', model: 'claude-sonnet-4-6' };
    kvGet.mockImplementation((k: string) => {
      if (k === 'ai-summary:TSLA') return Promise.resolve(cached);
      return Promise.resolve(null);
    });

    const { getOrCreateSummary } = await import('../../api/_lib/ai-summary');
    const result = await getOrCreateSummary('manual', 'TSLA', { refresh: false });

    expect(result.cached).toBe(true);
    expect(result.summary).toBe('cached text');
    expect(claudeCreate).not.toHaveBeenCalled();
  });

  it('a refresh during cooldown serves cache WITHOUT calling Claude', async () => {
    // cooldown key is set → refresh should serve existing cache, not call Claude
    const cached = { summary: 'cached summary', generated_at: '2026-06-25T12:00:00Z', model: 'claude-sonnet-4-6' };
    kvGet.mockImplementation((k: string) => {
      if (k === 'ai-summary:cooldown:TSLA') return Promise.resolve(1);   // cooldown active
      if (k === 'ai-summary:TSLA') return Promise.resolve(cached);        // cache present
      return Promise.resolve(null);
    });

    const { getOrCreateSummary } = await import('../../api/_lib/ai-summary');
    const result = await getOrCreateSummary('manual', 'TSLA', { refresh: true });

    // Cache is served — Claude is NOT called
    expect(claudeCreate).toHaveBeenCalledTimes(0);
    expect(result.summary).toBe('cached summary');
    expect(result.cached).toBe(true);
  });

  it('a refresh after cooldown expires DOES call Claude', async () => {
    // cooldown key is NOT set → allowed through
    claudeCreate.mockResolvedValue(stubbedClaudeResp());
    kvGet.mockImplementation((k: string) => {
      if (k === 'ai-summary:cooldown:TSLA') return Promise.resolve(null); // no cooldown
      if (k === 'ai-summary:TSLA') return Promise.resolve(null);          // no existing cache
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');

    const { getOrCreateSummary } = await import('../../api/_lib/ai-summary');
    const result = await getOrCreateSummary('manual', 'TSLA', { refresh: true });

    // Claude was called exactly once (through callClaude)
    expect(claudeCreate).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.summary).toBe('Stock is doing things.');

    // Cooldown key written with ex:60
    const cooldownCall = kvSet.mock.calls.find((c: any[]) => c[0] === 'ai-summary:cooldown:TSLA');
    expect(cooldownCall).toBeTruthy();
    expect(cooldownCall![1]).toBe(1);
    expect(cooldownCall![2]).toMatchObject({ ex: 60 });
  });

  it('a refresh during cooldown with no existing cache still generates (never leaves user with nothing)', async () => {
    // cooldown active but NO cached summary — must fall through and generate
    claudeCreate.mockResolvedValue(stubbedClaudeResp());
    kvGet.mockImplementation((k: string) => {
      if (k === 'ai-summary:cooldown:TSLA') return Promise.resolve(1);  // cooldown active
      if (k === 'ai-summary:TSLA') return Promise.resolve(null);         // no cache
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');

    const { getOrCreateSummary } = await import('../../api/_lib/ai-summary');
    const result = await getOrCreateSummary('manual', 'TSLA', { refresh: true });

    // Generates because no cache to serve
    expect(claudeCreate).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe('Stock is doing things.');
  });
});
