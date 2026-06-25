// dashboard/api/_lib/ai-summary.ts
//
// Robinhood-style AI summary for the /lookup/:symbol page. Gathers the data we
// already fetch for that page (live quote, options chain, news, earnings date),
// asks Claude Sonnet 4.6 — with the web_search server tool — to write a short
// plain-English "what is this stock doing and why" blurb that also covers the
// options picture (implied volatility, near-term put/call lean, earnings
// proximity), and caches the result per symbol in KV for 15 minutes so repeat
// lookups of the same symbol are free.
//
// The Claude call mirrors the pattern in grading.ts (same SDK, prompt caching,
// plain-English no-jargon system prompt). The pure helpers (buildOptionsDigest,
// extractText, buildUserPrompt, daysUntil) are exported separately and unit
// tested without any network or Anthropic dependency.
import Anthropic from '@anthropic-ai/sdk';
import { alpacaData, alpacaTrade } from './data-api.js';
import { fetchEarningsDate } from './fundamentals-fetch.js';
import { kv } from './kv.js';
import type { Mode } from './alpaca.js';

const MODEL = 'claude-sonnet-4-6';
const CACHE_TTL_SECONDS = 15 * 60; // 15 min — Robinhood's "Updated Xm ago" cadence
const MAX_PAUSE_TURNS = 4; // server web-search loop safety cap

export interface StoredSummary {
  summary: string;
  generated_at: string;
  model: string;
}

export interface AiSummaryResult extends StoredSummary {
  cached: boolean;
}

// ---- shapes of the raw Alpaca data we read (subset of fields we touch) ----
interface RawContract {
  symbol: string;
  expiration_date: string;
  strike_price: string;
  type: 'call' | 'put';
  open_interest?: string;
}
interface RawOptionSnapshot {
  impliedVolatility?: number;
  openInterest?: number;
  latestQuote?: { ap: number; bp: number };
}
interface RawNews {
  headline?: string;
  Headline?: string;
  source?: string;
  Source?: string;
  created_at?: string;
  CreatedAt?: string;
}

export interface QuoteInfo {
  price: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
}

export interface OptionsDigest {
  nearest_expiration: string | null;
  expirations_count: number;
  atm_iv_pct: number | null;
  put_call_oi_ratio: number | null;
  earnings_date: string | null;
  days_to_earnings: number | null;
}

// --------------------------- pure helpers ---------------------------

/** Whole calendar days from `now` until an ISO date (negative if past). null if unparseable. */
export function daysUntil(dateStr: string | null | undefined, now: Date): number | null {
  if (!dateStr) return null;
  const ms = Date.parse(dateStr);
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - now.getTime()) / 86_400_000);
}

/**
 * Compress a full options chain into a few decision-relevant numbers:
 *   - the nearest forward expiration and how many expirations exist
 *   - at-the-money implied volatility (avg of the nearest-strike call + put IV)
 *   - the put/call open-interest ratio on that nearest expiration (sentiment lean)
 * Pure — takes already-fetched contracts + snapshots, no network.
 */
export function buildOptionsDigest(
  spot: number | null,
  contracts: RawContract[],
  snapshots: Record<string, RawOptionSnapshot>,
  earningsDate: string | null,
  now: Date,
): OptionsDigest {
  const expirations = [...new Set(contracts.map((c) => c.expiration_date))]
    .filter((e) => {
      const d = daysUntil(e, now);
      return d !== null && d >= 0;
    })
    .sort();
  const nearest = expirations[0] ?? null;

  let atmIvPct: number | null = null;
  let putCallOi: number | null = null;

  if (nearest && spot && spot > 0) {
    const nearContracts = contracts.filter((c) => c.expiration_date === nearest);

    const nearestStrike = (type: 'call' | 'put'): RawContract | null => {
      const ofType = nearContracts.filter((c) => c.type === type);
      if (ofType.length === 0) return null;
      return ofType.reduce((best, c) =>
        Math.abs(Number(c.strike_price) - spot) < Math.abs(Number(best.strike_price) - spot) ? c : best,
      );
    };

    const atmCall = nearestStrike('call');
    const atmPut = nearestStrike('put');
    const ivs: number[] = [];
    for (const c of [atmCall, atmPut]) {
      const iv = c ? snapshots[c.symbol]?.impliedVolatility : undefined;
      if (typeof iv === 'number' && iv > 0) ivs.push(iv);
    }
    if (ivs.length > 0) {
      atmIvPct = Math.round((ivs.reduce((a, b) => a + b, 0) / ivs.length) * 1000) / 10; // → percent, 1 dp
    }

    const oiOf = (c: RawContract): number => {
      const fromContract = c.open_interest != null ? Number(c.open_interest) : NaN;
      if (Number.isFinite(fromContract)) return fromContract;
      const fromSnap = snapshots[c.symbol]?.openInterest;
      return typeof fromSnap === 'number' ? fromSnap : 0;
    };
    const putOi = nearContracts.filter((c) => c.type === 'put').reduce((a, c) => a + oiOf(c), 0);
    const callOi = nearContracts.filter((c) => c.type === 'call').reduce((a, c) => a + oiOf(c), 0);
    if (callOi > 0) putCallOi = Math.round((putOi / callOi) * 100) / 100;
  }

  return {
    nearest_expiration: nearest,
    expirations_count: expirations.length,
    atm_iv_pct: atmIvPct,
    put_call_oi_ratio: putCallOi,
    earnings_date: earningsDate,
    days_to_earnings: daysUntil(earningsDate, now),
  };
}

/** Pull all text from an Anthropic response content array, ignoring tool-use / tool-result blocks. */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } =>
      !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('')
    .trim();
}

export const SYSTEM_PROMPT = `You are a market-summary writer for one retail investor's personal dashboard. You write a short, plain-English blurb describing what a single stock is doing right now and why — similar in spirit to the one-paragraph summaries at the top of a Robinhood stock page.

Hard rules:
- Plain English only. If you must use a finance term, define it inline in the same sentence (e.g. "implied volatility — the market's estimate of how much the stock will swing"). Never leave jargon like IV, OI, DTE, ATM, theta, or RSI undefined.
- 3 to 5 sentences. One tight paragraph. No headers, no bullet points, no markdown, no preamble like "Here is" or "This stock".
- Use the web_search tool to find the ACTUAL reason behind today's price move (earnings, news, an analyst call, a sector move, a short squeeze, etc.). If you genuinely can't find a specific catalyst, say the move looks like broader market or sector drift rather than inventing a reason.
- Weave in the options picture from the data provided: whether implied volatility looks high or low (and what that means for option premiums), any clear lean toward puts or calls, and whether an earnings report is coming up soon (earnings near-term means bigger expected swings).
- Describe and explain. Do NOT give advice, recommendations, price targets, or predictions ("could go higher", "good entry", "I'd buy"). State what is happening and why, not what the reader should do.
- Write in present tense, third person. End the paragraph naturally — the UI appends its own "not advice" disclaimer.`;

/** Build the user-turn prompt from the gathered facts. Pure / testable. */
export function buildUserPrompt(
  symbol: string,
  quote: QuoteInfo,
  digest: OptionsDigest,
  headlines: string[],
): string {
  const lines: string[] = [];
  lines.push(`Stock: ${symbol}`);
  if (quote.price != null) lines.push(`Current price: $${quote.price.toFixed(2)}`);
  if (quote.change != null && quote.changePct != null) {
    const dir = quote.change >= 0 ? 'up' : 'down';
    lines.push(`Today's move: ${dir} $${Math.abs(quote.change).toFixed(2)} (${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}%)`);
  }
  if (quote.dayLow != null && quote.dayHigh != null) lines.push(`Day range: $${quote.dayLow} – $${quote.dayHigh}`);
  if (quote.volume != null) lines.push(`Volume today: ${quote.volume.toLocaleString('en-US')}`);

  lines.push('');
  lines.push('Options snapshot:');
  lines.push(`- Nearest expiration: ${digest.nearest_expiration ?? 'n/a'} (${digest.expirations_count} expirations available)`);
  lines.push(`- At-the-money implied volatility: ${digest.atm_iv_pct != null ? `${digest.atm_iv_pct}%` : 'unavailable'}`);
  lines.push(`- Put/call open-interest ratio (nearest expiration): ${digest.put_call_oi_ratio != null ? digest.put_call_oi_ratio.toFixed(2) : 'unavailable'} (above 1 = more puts than calls; below 1 = more calls)`);
  if (digest.earnings_date) {
    lines.push(`- Next earnings: ${digest.earnings_date}${digest.days_to_earnings != null ? ` (in ${digest.days_to_earnings} days)` : ''}`);
  } else {
    lines.push('- Next earnings: unknown');
  }

  if (headlines.length > 0) {
    lines.push('');
    lines.push('Recent headlines (from the broker feed — verify/expand with web search):');
    for (const h of headlines.slice(0, 5)) lines.push(`- ${h}`);
  }

  lines.push('');
  lines.push(`Write the summary for ${symbol} now.`);
  return lines.join('\n');
}

// --------------------------- data gathering ---------------------------

function parseQuote(snapshotResp: unknown, symbol: string): QuoteInfo {
  const empty: QuoteInfo = { price: null, change: null, changePct: null, dayHigh: null, dayLow: null, volume: null };
  if (!snapshotResp || typeof snapshotResp !== 'object') return empty;
  const root = snapshotResp as Record<string, unknown>;
  const snap = (symbol in root ? root[symbol] : root) as
    | { latestTrade?: { p: number }; dailyBar?: { c: number; h: number; l: number; v: number }; prevDailyBar?: { c: number } }
    | undefined;
  if (!snap) return empty;
  const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? null;
  const prev = snap.prevDailyBar?.c ?? null;
  const change = price != null && prev != null ? price - prev : null;
  const changePct = change != null && prev ? (change / prev) * 100 : null;
  return {
    price,
    change,
    changePct,
    dayHigh: snap.dailyBar?.h ?? null,
    dayLow: snap.dailyBar?.l ?? null,
    volume: snap.dailyBar?.v ?? null,
  };
}

function parseHeadlines(newsResp: unknown): string[] {
  const arr = (newsResp && typeof newsResp === 'object' ? (newsResp as { news?: unknown[] }).news : undefined) ?? [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((n) => {
      const a = n as RawNews;
      return a.Headline ?? a.headline ?? '';
    })
    .filter((h) => h.length > 0);
}

async function gatherContext(mode: Mode, symbol: string): Promise<{ quote: QuoteInfo; digest: OptionsDigest; headlines: string[] }> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Run the independent reads concurrently. Each is best-effort — a failure on
  // any one degrades the summary rather than killing it.
  const [snapResp, contractsResp, newsResp, earningsDate] = await Promise.all([
    alpacaData<unknown>(mode, '/v2/stocks/snapshots', { symbols: symbol }).catch(() => null),
    alpacaTrade<{ option_contracts?: RawContract[] }>(mode, '/v2/options/contracts', {
      underlying_symbols: symbol,
      status: 'active',
      limit: 10000,
      expiration_date_gte: today,
    }).catch(() => ({ option_contracts: [] as RawContract[] })),
    alpacaData<unknown>(mode, '/v1beta1/news', { symbols: symbol, limit: 10 }).catch(() => null),
    fetchEarningsDate(symbol).catch(() => null),
  ]);

  const quote = parseQuote(snapResp, symbol);
  const contracts = Array.isArray(contractsResp.option_contracts) ? contractsResp.option_contracts : [];

  // Snapshot the nearest expiration's strikes near spot so we have implied
  // volatility for the ATM contracts. Keep it to one ≤100-symbol chunk.
  const expirations = [...new Set(contracts.map((c) => c.expiration_date))].sort();
  const nearest = expirations.find((e) => {
    const d = daysUntil(e, now);
    return d !== null && d >= 0;
  });
  let snapshots: Record<string, RawOptionSnapshot> = {};
  if (nearest && quote.price) {
    const band = quote.price * 0.2;
    const targets = contracts
      .filter((c) => c.expiration_date === nearest && Math.abs(Number(c.strike_price) - quote.price!) <= band)
      .map((c) => c.symbol)
      .slice(0, 100);
    if (targets.length > 0) {
      try {
        const snapResp2 = await alpacaData<{ snapshots?: Record<string, RawOptionSnapshot> }>(
          mode,
          '/v1beta1/options/snapshots',
          { symbols: targets.join(',') },
        );
        snapshots = snapResp2.snapshots ?? {};
      } catch {
        snapshots = {};
      }
    }
  }

  const digest = buildOptionsDigest(quote.price, contracts, snapshots, earningsDate, now);
  const headlines = parseHeadlines(newsResp);
  return { quote, digest, headlines };
}

// --------------------------- Claude call ---------------------------

async function callClaude(userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const client = new Anthropic({ apiKey });

  const system = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  // Server-side web search tool. Pure passthrough — cast to any so the older
  // SDK's tool typing doesn't reject the server-tool shape.
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }];

  async function once(useTools: boolean) {
    let messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: userPrompt }];
    let resp = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: system as never,
      messages: messages as never,
      ...(useTools ? { tools: tools as never } : {}),
    });
    let guard = 0;
    while (resp.stop_reason === 'pause_turn' && guard < MAX_PAUSE_TURNS) {
      messages = [{ role: 'user', content: userPrompt }, { role: 'assistant', content: resp.content }];
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: 700,
        system: system as never,
        messages: messages as never,
        ...(useTools ? { tools: tools as never } : {}),
      });
      guard++;
    }
    return extractText(resp.content);
  }

  try {
    const text = await once(true);
    if (text) return text;
    // Empty (e.g. tool churn without a final paragraph) — fall back to no tools.
    return await once(false);
  } catch {
    // Web search unavailable / rejected — degrade gracefully to a data-only summary.
    return await once(false);
  }
}

// --------------------------- public entry point ---------------------------

function cacheKey(symbol: string): string {
  return `ai-summary:${symbol}`;
}

export async function getOrCreateSummary(
  mode: Mode,
  symbol: string,
  opts: { refresh?: boolean } = {},
): Promise<AiSummaryResult> {
  const key = cacheKey(symbol);
  if (!opts.refresh) {
    const cached = await kv().get<StoredSummary>(key);
    if (cached && cached.summary) return { ...cached, cached: true };
  }

  const { quote, digest, headlines } = await gatherContext(mode, symbol);
  const userPrompt = buildUserPrompt(symbol, quote, digest, headlines);
  const summary = await callClaude(userPrompt);
  if (!summary) throw new Error('empty_summary');

  const stored: StoredSummary = { summary, generated_at: new Date().toISOString(), model: MODEL };
  await kv().set(key, stored, { ex: CACHE_TTL_SECONDS });
  return { ...stored, cached: false };
}
