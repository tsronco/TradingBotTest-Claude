import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: messagesCreate };
      constructor(_opts?: any) {}
    },
  };
});

import type { Finding } from '../../api/_lib/tendency-matchers';

const sampleFinding: Finding = {
  matcher: 'loss_concentration_by_symbol',
  finding: 'F losing 3/3, total P&L -350',
  evidence_trade_ids: ['T-1', 'T-2', 'T-3'],
  key: 'loss_concentration_by_symbol:F',
  actionable: true,
  suggested_severity: 'warn',
  suggested_triggers: [{ type: 'symbol_in', symbols: ['F'] }],
};

describe('proposeNewRule', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });

  it('parses Sonnet JSON output into a Proposal-shaped object', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          proposed_rule_title: 'Stop trading F',
          proposed_rule_body: 'Three losses in a row tells me F is not in my edge right now. Skip it for the next 30 days.',
          suggested_severity: 'warn',
          suggested_triggers: [{ type: 'symbol_in', symbols: ['F'] }],
          reasoning: 'You traded F 3 times and lost on all three. Total P&L -$350.',
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 480 },
    });
    const { proposeNewRule } = await import('../../api/_lib/proposal-prompts');
    const out = await proposeNewRule(sampleFinding, []);
    expect(out.proposed_rule.title).toBe('Stop trading F');
    expect(out.proposed_rule.severity).toBe('warn');
    expect(out.matcher).toBe('loss_concentration_by_symbol');
    expect(out.evidence_trade_ids).toEqual(['T-1', 'T-2', 'T-3']);
    expect(out.id).toMatch(/^p-/);
    expect(out.status).toBe('open');
  });

  it('coerces invalid severity to "warn"', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          proposed_rule_title: 't',
          proposed_rule_body: 'b',
          suggested_severity: 'NOT_A_REAL_SEVERITY',
          suggested_triggers: [],
          reasoning: 'r',
        }),
      }],
      usage: {},
    });
    const { proposeNewRule } = await import('../../api/_lib/proposal-prompts');
    const out = await proposeNewRule(sampleFinding, []);
    expect(out.proposed_rule.severity).toBe('warn');
  });

  it('falls back to finding.suggested_triggers when LLM returns non-array', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          proposed_rule_title: 't',
          proposed_rule_body: 'b',
          suggested_severity: 'warn',
          suggested_triggers: 'oops',
          reasoning: 'r',
        }),
      }],
      usage: {},
    });
    const { proposeNewRule } = await import('../../api/_lib/proposal-prompts');
    const out = await proposeNewRule(sampleFinding, []);
    expect(out.proposed_rule.triggers).toEqual([{ type: 'symbol_in', symbols: ['F'] }]);
  });

  it('extracts JSON from a response wrapped in prose/fences', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: 'Sure! Here is the rule:\n\n```json\n{"proposed_rule_title":"X","proposed_rule_body":"Y","suggested_severity":"warn","suggested_triggers":[],"reasoning":"R"}\n```',
      }],
      usage: {},
    });
    const { proposeNewRule } = await import('../../api/_lib/proposal-prompts');
    const out = await proposeNewRule(sampleFinding, []);
    expect(out.proposed_rule.title).toBe('X');
  });

  it('throws on completely unparseable output', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'no json here at all' }],
      usage: {},
    });
    const { proposeNewRule } = await import('../../api/_lib/proposal-prompts');
    await expect(proposeNewRule(sampleFinding, [])).rejects.toThrow(/unparseable/);
  });

  it('clips title and body to safe lengths', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          proposed_rule_title: 'x'.repeat(500),
          proposed_rule_body: 'y'.repeat(5000),
          suggested_severity: 'block',
          suggested_triggers: [],
          reasoning: 'z'.repeat(2000),
        }),
      }],
      usage: {},
    });
    const { proposeNewRule } = await import('../../api/_lib/proposal-prompts');
    const out = await proposeNewRule(sampleFinding, []);
    expect(out.proposed_rule.title.length).toBeLessThanOrEqual(200);
    expect(out.proposed_rule.body.length).toBeLessThanOrEqual(2000);
    expect(out.reasoning.length).toBeLessThanOrEqual(1000);
  });
});

describe('proposeDemote', () => {
  it('builds a demote proposal templated from rule + stats (no LLM)', async () => {
    const { proposeDemote } = await import('../../api/_lib/proposal-prompts');
    const rule = {
      id: 'r-1', title: 'No earnings week',
      body: 'never trade through earnings', severity: 'block' as const,
      triggers: [{ type: 'earnings_within_days' as const, value: 7 }],
      source: 'manual' as const,
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    };
    const out = proposeDemote(rule, { overrides: 5, profitable_pct: 0.8 });
    expect(out.demote_target_rule_id).toBe('r-1');
    expect(out.proposed_rule.severity).toBe('warn');
    expect(out.proposed_rule.title).toContain('Demote');
    expect(out.reasoning).toContain('5 times');
    expect(out.reasoning).toContain('80%');
  });
});
