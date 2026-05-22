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

  it('uses spread-aware hindsight prompt for spread trades', async () => {
    const spreadTrade = {
      id: 'T-2026-05-25-001',
      account: 'conservative_paper',
      asset_class: 'spread',
      symbol: 'AAL',
      submitted_at: '2026-05-15T14:00:00Z',
      filled_at: '2026-05-15T14:00:15Z',
      closed_at: '2026-05-25T20:00:00Z',
      closed_avg_price: 0.12,
      closed_by: 'manual',
      entry_grade: 'B+',
      entry_reasoning: 'Bullish AAL above $12.50',
      spread: {
        spread_type: 'put_credit',
        short_leg: { strike: 12.5, fill_price: 0.37, qty: 1 },
        long_leg: { strike: 11.5, fill_price: 0.12, qty: 1 },
        net_credit: 0.25,
        max_loss: 0.75,
        width: 1,
        expiration: '2026-05-29',
      },
      schema: 1,
    } as any;
    claudeCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"letter":"B+","review":"ok","calibration":"matched","tendencies_hit":[]}' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    });
    const { gradeTrade } = await import('../../api/_lib/grading');
    await gradeTrade({ trade: spreadTrade, bars: [] });
    const userMsg = claudeCreate.mock.calls[0][0].messages[0].content;
    expect(userMsg).toContain('put credit spread');
    expect(userMsg).toContain('12.50');
    expect(userMsg).toContain('11.50');
    expect(userMsg).toContain('0.25');
    expect(userMsg).toContain('0.75');
    expect(userMsg).toContain('closed');
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

  it('injects the configured display name into the system prompt', async () => {
    // kv.get is shared between rules:* lookups and config:display_name.
    // Return the name only for the display-name key; pass-through for others.
    kvGet.mockImplementation((key: string) => {
      if (key === 'config:display_name') return Promise.resolve('Pat');
      return Promise.resolve(null);
    });
    claudeCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"letter":"B","review":"ok","calibration":"matched","tendencies_hit":[]}' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    });
    const { gradeTrade } = await import('../../api/_lib/grading');
    await gradeTrade({ trade, bars: [] });
    const sysBlocks = claudeCreate.mock.calls[0][0].system as Array<{ text: string }>;
    const sysText = sysBlocks.map((b) => b.text).join('\n');
    expect(sysText).toContain('(Pat)');
    expect(sysText).not.toContain('(Tim)');
  });

  it('falls back to "the trader" when no display name is configured', async () => {
    // kvGet already returns null by default (see beforeEach)
    claudeCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"letter":"B","review":"ok","calibration":"matched","tendencies_hit":[]}' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    });
    const { gradeTrade } = await import('../../api/_lib/grading');
    await gradeTrade({ trade, bars: [] });
    const sysBlocks = claudeCreate.mock.calls[0][0].system as Array<{ text: string }>;
    const sysText = sysBlocks.map((b) => b.text).join('\n');
    expect(sysText).toContain('(the trader)');
  });
});
