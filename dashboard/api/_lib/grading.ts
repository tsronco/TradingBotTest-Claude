// dashboard/api/_lib/grading.ts
import Anthropic from '@anthropic-ai/sdk';
import { kv } from './kv.js';
import type { Trade, GradeHindsight, Calibration } from './trade-types.js';
import { calibrationFor, GRADE_LETTERS, type GradeLetter } from './trade-types.js';

const SYSTEM_PROMPT = `You are an honest trading coach for a single trader (Tim). Your job is to grade a closed manual trade A+ to F based on what actually happened versus what the trader said when entering.

Hard rules:
- Plain English only. Never use trader shorthand (LH, LL, HOD, RR, IV, RSI, theta, delta, gamma, vega) without defining it inline in the same sentence.
- If the trader made a bad call, say so directly. No hedging, no cheerleading. The point is to improve, not to feel good.
- Grade the *decision-making*, not the outcome. A bad process that got lucky still gets a low grade. A good process that got unlucky still gets a high grade.
- Compare against the trader's own entry reasoning. If they took credit for something that wasn't the actual driver, call it out.
- "tendencies_hit" is a list of pattern names from the provided tendencies set. Empty array if none apply. Do not invent new ones.

Output strict JSON. No prose outside the JSON. Schema:
{
  "letter": "A+|A|A-|B+|B|B-|C+|C|C-|D|F",
  "review": "<plain-english review, 60-120 words>",
  "calibration": "matched|over_1|over_2|under_1|under_2",
  "tendencies_hit": ["<tendency-id>", ...]
}

"calibration" compares your letter to the trader's entry letter:
"matched" = same letter
"over_1"  = trader was 1 step too high
"over_2"  = trader was 2+ steps too high
"under_1" = trader was 1 step too low
"under_2" = trader was 2+ steps too low`;

interface CachedReference {
  manual: string;
  tendencies: any[];
  patterns: any[];
  cheatsheets: any[];
}

async function loadCachedReference(): Promise<CachedReference> {
  const manual = (await kv().get<string>('rules:manual'))
    ?? 'manual rules not yet defined — grade based on trade record alone.';
  const tendencies = (await kv().get<any[]>('rules:tendencies')) ?? [];
  const patterns = (await kv().get<any[]>('rules:patterns')) ?? [];
  const cheatsheets = (await kv().get<any[]>('rules:cheatsheets')) ?? [];
  return { manual, tendencies, patterns, cheatsheets };
}

function buildCachedBlock(ref: CachedReference): string {
  return `Reference (cached):

Manual rules:
${ref.manual}

Known tendencies (use only these for tendencies_hit):
${ref.tendencies.length ? JSON.stringify(ref.tendencies, null, 2) : '(none)'}

Playbook patterns:
${ref.patterns.length ? JSON.stringify(ref.patterns, null, 2) : '(none)'}

Cheatsheets:
${ref.cheatsheets.length ? JSON.stringify(ref.cheatsheets, null, 2) : '(none)'}`;
}

function spreadTypeLabel(t: string): string {
  switch (t) {
    case 'put_credit': return 'put credit spread';
    case 'call_credit': return 'call credit spread';
    default: return `${t.replace(/_/g, ' ')} spread`;
  }
}

function buildSpreadFreshBlock(trade: Trade, bars: Array<{ t: string; c: number }>): string {
  const sp = trade.spread!;
  const closeValue = trade.closed_avg_price ?? 0;
  const profitDollars = (sp.net_credit - closeValue) * 100 * sp.short_leg.qty;
  const label = spreadTypeLabel(sp.spread_type);
  return `You are doing a hindsight review of a closed paper ${label}.

Underlying: ${trade.symbol}
Short ${sp.short_leg.strike.toFixed(2)} / Long ${sp.long_leg.strike.toFixed(2)}
Expiration: ${sp.expiration}
Net credit at open: $${sp.net_credit.toFixed(2)}
Max loss at open: $${sp.max_loss.toFixed(2)}
Cost to close: $${closeValue.toFixed(2)}
Realized: $${profitDollars.toFixed(2)} (closed by ${trade.closed_by})

Price bars during position lifetime (1-min closes on the underlying):
${bars.length ? bars.slice(0, 240).map((b) => `${b.t}\t${b.c}`).join('\n') : '(no bars available)'}

User's entry grade: ${trade.entry_grade}
User's entry reasoning: "${trade.entry_reasoning}"

With hindsight, grade the entry decision per the system rules, considering: (1) strike selection vs spot at entry, (2) DTE choice, (3) risk/reward (credit vs max loss), (4) whether the realized result confirms or undermines the entry thesis. Output JSON only.`;
}

function buildFreshBlock(trade: Trade, bars: Array<{ t: string; c: number }>): string {
  if (trade.asset_class === 'spread' && trade.spread) {
    return buildSpreadFreshBlock(trade, bars);
  }
  const safeTrade = { ...trade, alpaca_order_id: undefined, alpaca_close_order_id: undefined };
  return `Trade record (id: ${trade.id}):
${JSON.stringify(safeTrade, null, 2)}

Price bars during position lifetime (1-min closes):
${bars.length ? bars.slice(0, 240).map((b) => `${b.t}\t${b.c}`).join('\n') : '(no bars available)'}

User's entry grade: ${trade.entry_grade}
User's entry reasoning: "${trade.entry_reasoning}"

Now grade this trade per the system rules. Output JSON only.`;
}

function tryParse(text: string, traderLetter: GradeLetter): GradeHindsight | null {
  // strip code-fence wrappers if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let obj: any;
  try { obj = JSON.parse(cleaned); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!GRADE_LETTERS.includes(obj.letter)) return null;
  if (typeof obj.review !== 'string') return null;
  const calibration: Calibration = obj.calibration ?? calibrationFor(traderLetter, obj.letter);
  return {
    letter: obj.letter,
    review: obj.review,
    calibration,
    tendencies_hit: Array.isArray(obj.tendencies_hit) ? obj.tendencies_hit : [],
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
    ts: new Date().toISOString(),
  };
}

interface GradeInput {
  trade: Trade;
  bars: Array<{ t: string; c: number }>;
}

export async function gradeTrade(input: GradeInput): Promise<GradeHindsight> {
  const { trade, bars } = input;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
  const ref = await loadCachedReference();
  const cached = buildCachedBlock(ref);
  const fresh = buildFreshBlock(trade, bars);

  async function callOnce(systemSuffix = ''): Promise<{ text: string; usage: any }> {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: [
        { type: 'text', text: SYSTEM_PROMPT + systemSuffix },
        { type: 'text', text: cached, cache_control: { type: 'ephemeral' } },
      ] as any,
      messages: [{ role: 'user', content: fresh }],
    });
    const block = resp.content.find((b: any) => b.type === 'text') as any;
    return { text: block?.text ?? '', usage: resp.usage };
  }

  const first = await callOnce();
  let parsed = tryParse(first.text, trade.entry_grade);
  let usage = first.usage;
  let raw = first.text;

  if (!parsed) {
    const retry = await callOnce('\n\nIMPORTANT: Output ONLY valid JSON. No prose, no markdown fences.');
    parsed = tryParse(retry.text, trade.entry_grade);
    usage = retry.usage;
    raw = retry.text;
  }

  if (!parsed) {
    return {
      letter: trade.entry_grade,
      review: '',
      calibration: 'matched',
      tendencies_hit: [],
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cached_tokens: usage?.cache_read_input_tokens ?? 0,
      },
      ts: new Date().toISOString(),
      parse_failed: true,
      raw,
    };
  }

  return {
    ...parsed,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cached_tokens: usage?.cache_read_input_tokens ?? 0,
    },
  };
}
