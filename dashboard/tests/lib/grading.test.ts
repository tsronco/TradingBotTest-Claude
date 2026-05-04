// dashboard/tests/lib/grading.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const claudeCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: (...a: any[]) => claudeCreate(...a) }; },
}));

const kvGet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet }) }));

beforeEach(() => {
  claudeCreate.mockReset();
  kvGet.mockResolvedValue(null);
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

const trade = {
  id: 'T-2026-05-04-001',
  account: 'conservative_paper',
  asset_class: 'stock',
  symbol: 'TSLA',
  side: 'buy',
  qty: 10,
  filled_avg_price: 319.85,
  closed_avg_price: 362.20,
  realized_pnl: 423.50,
  closed_at: '2026-05-04T20:09:00Z',
  filled_at: '2026-05-04T13:30:15Z',
  submitted_at: '2026-05-04T13:30:00Z',
  entry_grade: 'A',
  entry_reasoning: 'breakout above $318 resistance',
  exposure_at_submit: 3198.50,
  rule_warnings_at_entry: [],
  schema: 1,
} as any;

describe('gradeTrade', () => {
  it('builds a prompt with system + cached + fresh blocks and parses JSON', async () => {
    claudeCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"letter":"B+","review":"thesis was right","calibration":"over_1","tendencies_hit":[]}' }],
      usage: { input_tokens: 1942, output_tokens: 287, cache_read_input_tokens: 0 },
    });
    const { gradeTrade } = await import('../../api/_lib/grading');
    const result = await gradeTrade({ trade, bars: [] });
    expect(result.parse_failed).toBeUndefined();
    expect(result.letter).toBe('B+');
    expect(result.calibration).toBe('over_1');
    expect(result.usage.input_tokens).toBe(1942);
    const callArgs = claudeCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-sonnet-4-6');
    expect(callArgs.system).toBeDefined();
    // cache marker present on at least one block
    const sysBlocks = Array.isArray(callArgs.system) ? callArgs.system : [];
    expect(sysBlocks.some((b: any) => b.cache_control?.type === 'ephemeral')).toBe(true);
  });

  it('retries with stricter prompt on malformed JSON', async () => {
    claudeCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not json' }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"letter":"B","review":"redo","calibration":"matched","tendencies_hit":[]}' }],
        usage: { input_tokens: 110, output_tokens: 50, cache_read_input_tokens: 0 },
      });
    const { gradeTrade } = await import('../../api/_lib/grading');
    const result = await gradeTrade({ trade, bars: [] });
    expect(claudeCreate).toHaveBeenCalledTimes(2);
    expect(result.letter).toBe('B');
  });

  it('marks parse_failed when both attempts return junk', async () => {
    claudeCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'junk' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    });
    const { gradeTrade } = await import('../../api/_lib/grading');
    const result = await gradeTrade({ trade, bars: [] });
    expect(result.parse_failed).toBe(true);
    expect(result.raw).toBe('junk');
  });
});
