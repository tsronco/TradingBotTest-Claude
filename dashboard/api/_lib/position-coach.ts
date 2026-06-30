// dashboard/api/_lib/position-coach.ts
//
// Position-aware EDUCATIONAL coach for the /lookup/:symbol page. When the user
// holds the symbol in an account, this assembles a deterministic facts object
// (their position from Alpaca + what the bot is currently doing with it, read
// from the bot's own KV state) and asks Claude Sonnet to narrate those numbers
// in plain English for a beginner.
//
// HARD BOUNDARY: this is education, not advice. The model never recommends a
// buy/sell/hold, never gives a price target, never predicts. It only restates
// the numbers it was handed and defines the jargon. Every figure the panel
// shows is computed in code here (Layer 1) — the model (Layer 2) phrases but
// cannot fabricate. If the model is unavailable, the panel falls back to the
// deterministic readout so the facts always render.
//
// Mirrors ai-summary.ts in structure: pure helpers (buildPositionFacts,
// buildCoachPrompt, deterministicReadout) are exported and unit-tested without
// any network, KV, or Anthropic dependency.
import Anthropic from '@anthropic-ai/sdk';
import { alpacaTrade } from './data-api.js';
import { getJson, kv } from './kv.js';
import type { Mode } from './alpaca.js';

const MODEL = 'claude-sonnet-4-6';
const CACHE_TTL_SECONDS = 15 * 60; // upper bound; signature busts it sooner on a real change

// Symbols the bot is configured to leave alone, per mode. Mirrors
// config.MODES[mode].excluded_symbols on the bot side. Empty today (SNAP was
// removed 2026-06-29 once the position closed); kept as a typed seam so the
// coach can note "the bot is set to ignore this one" if a symbol is re-excluded.
export const EXCLUDED_SYMBOLS: Record<Mode, string[]> = {
  manual: [],
  live: [],
};

// ---- raw shapes we read (subset of fields we touch) ----
export interface RawPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price?: string | null;
  unrealized_pl?: string | null;
  unrealized_plpc?: string | null;
  asset_class?: string;
  side?: string; // 'long' | 'short'
}

// Per-symbol block inside the bot's strategy_state_<mode>.json (pushed to
// KV as bot:strategy:<mode>). Only the fields the coach narrates.
export interface RawStrategySym {
  stop_price?: number | null;
  high_water_mark?: number | null;
  trailing_active?: boolean | null;
  ladder_done?: boolean[] | null;
  initial_qty?: number | null;
}

// Per-symbol block inside the bot's wheel_state_<mode>.json (bot:state:<mode>).
export interface RawWheelSym {
  stage?: number | string | null;
}

export interface PositionFacts {
  symbol: string;
  mode: Mode;
  is_live: boolean;
  asset_class: 'stock' | 'option' | 'other';
  side: 'long' | 'short';
  qty: number;
  avg_cost: number;
  current_price: number | null;
  unrealized_pl: number | null;
  unrealized_pl_pct: number | null; // percent (already ×100)
  // Bot strategy plan — null when the bot has never run this symbol yet.
  stop_price: number | null;
  trailing_active: boolean | null;
  high_water_mark: number | null;
  ladder_rungs_total: number | null;
  ladder_rungs_remaining: number | null;
  // Bot wheel stage (1 = cash-secured put, 2 = covered call) for option/wheel
  // positions; null otherwise.
  wheel_stage: number | null;
  is_excluded: boolean;
}

export interface StoredCoach {
  explainer: string;
  signature: string;
  generated_at: string;
  model: string;
}

export interface CoachResult {
  symbol: string;
  mode: Mode;
  held: boolean;
  facts: PositionFacts | null;
  explainer: string | null;
  generated_at: string | null;
  cached: boolean;
}

// --------------------------- pure helpers ---------------------------

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function classify(assetClass: string | undefined): 'stock' | 'option' | 'other' {
  if (assetClass === 'us_equity') return 'stock';
  if (assetClass === 'us_option' || assetClass === 'option') return 'option';
  return 'other';
}

/**
 * Assemble the deterministic facts from a held position plus the bot's own
 * strategy/wheel state. All math (P/L, ladder-rung accounting) happens here so
 * the LLM only ever restates pre-computed numbers. Pure / testable.
 */
export function buildPositionFacts(
  symbol: string,
  mode: Mode,
  position: RawPosition,
  strategySym: RawStrategySym | null,
  wheelSym: RawWheelSym | null,
  excluded: string[] = EXCLUDED_SYMBOLS[mode],
): PositionFacts {
  const qty = num(position.qty) ?? 0;
  const ladder = Array.isArray(strategySym?.ladder_done) ? strategySym!.ladder_done! : null;
  const rungsTotal = ladder ? ladder.length : null;
  const rungsRemaining = ladder ? ladder.filter((d) => !d).length : null;

  const stageRaw = wheelSym?.stage;
  const stage = stageRaw == null ? null : num(stageRaw);

  return {
    symbol,
    mode,
    is_live: mode === 'live',
    asset_class: classify(position.asset_class),
    side: position.side === 'short' ? 'short' : 'long',
    qty,
    avg_cost: num(position.avg_entry_price) ?? 0,
    current_price: num(position.current_price),
    unrealized_pl: num(position.unrealized_pl),
    unrealized_pl_pct: position.unrealized_plpc != null ? (num(position.unrealized_plpc) ?? 0) * 100 : null,
    stop_price: num(strategySym?.stop_price),
    trailing_active: strategySym?.trailing_active ?? null,
    high_water_mark: num(strategySym?.high_water_mark),
    ladder_rungs_total: rungsTotal,
    ladder_rungs_remaining: rungsRemaining,
    wheel_stage: stage,
    is_excluded: excluded.includes(symbol),
  };
}

export const SYSTEM_PROMPT = `You are an educational assistant for ONE beginner investor, explaining a position they already hold on their personal dashboard. You are NOT a financial advisor.

Your only job is to explain, in plain friendly English, what their position is and what their trading bot is configured to do with it — using ONLY the numbers you are given.

ABSOLUTE rules (a violation is a failure):
- NEVER tell the user to buy, sell, hold, add, trim, close, wait, or take any action. NEVER say "you should", "consider", "it may be wise", or similar.
- NEVER give a price target, forecast, or prediction about where the stock will go ("could rebound", "likely to fall", "good entry"). Do not characterize the position as good or bad.
- Every number in the input is FINAL and authoritative. Restate the numbers given — never recompute, estimate, round differently, or invent a figure (price, stop, P/L) that wasn't provided.
- Define each finance term in one short clause the first time it appears: a "stop" (the bot sells automatically if price falls to a set level, capping the loss), a "trailing stop" (a stop that ratchets up as the price rises but never moves down), a "ladder" (pre-planned add-on buys at lower prices), "wheel stage" (selling puts then covered calls).

What you MAY do:
- State the position plainly: how many shares/contracts, the average cost, the current price, and the unrealized profit or loss (paper gain/loss not yet realized).
- Explain what the bot is currently set to do with it: the stop level, whether the trailing stop is on, how many ladder rungs remain, the wheel stage.
- Name the general mechanical risk in neutral terms (e.g. "if the price reaches the stop, the bot sells and the loss becomes realized").

Style: at most 4 sentences. Plain language, calm, no hype, no markdown, no preamble. Present tense, second person ("you own…"). The UI appends its own "not advice" disclaimer, so do not add one.`;

function fmtUsd(n: number | null): string {
  return n == null ? 'unknown' : `$${n.toFixed(2)}`;
}

/** Build the user-turn prompt from the facts. Pure / testable. */
export function buildCoachPrompt(facts: PositionFacts): string {
  const lines: string[] = [];
  lines.push(`Account: ${facts.mode}${facts.is_live ? ' (REAL MONEY)' : ' (paper / practice money)'}`);
  lines.push(`Symbol: ${facts.symbol}`);
  lines.push(`Instrument: ${facts.asset_class}`);
  lines.push(`Position: ${facts.side} ${facts.qty} ${facts.asset_class === 'option' ? 'contract(s)' : 'share(s)'}`);
  lines.push(`Average cost: ${fmtUsd(facts.avg_cost)}`);
  lines.push(`Current price: ${fmtUsd(facts.current_price)}`);
  if (facts.unrealized_pl != null) {
    const dir = facts.unrealized_pl >= 0 ? 'gain' : 'loss';
    const pct = facts.unrealized_pl_pct != null ? ` (${facts.unrealized_pl_pct >= 0 ? '+' : ''}${facts.unrealized_pl_pct.toFixed(2)}%)` : '';
    lines.push(`Unrealized ${dir}: ${fmtUsd(Math.abs(facts.unrealized_pl))}${pct} — paper only, not yet realized`);
  }

  lines.push('');
  lines.push("What the bot is configured to do with this position:");
  if (facts.stop_price != null) {
    lines.push(`- Stop price: ${fmtUsd(facts.stop_price)} (bot sells if the stock falls to this level)`);
  } else {
    lines.push('- Stop price: none recorded yet (the bot has not set a stop for this symbol)');
  }
  if (facts.trailing_active != null) {
    lines.push(`- Trailing stop: ${facts.trailing_active ? 'ON' : 'OFF'}`);
  }
  if (facts.high_water_mark != null) {
    lines.push(`- Highest price seen since entry (high-water mark): ${fmtUsd(facts.high_water_mark)}`);
  }
  if (facts.ladder_rungs_remaining != null && facts.ladder_rungs_total != null) {
    lines.push(`- Ladder add-on buys remaining: ${facts.ladder_rungs_remaining} of ${facts.ladder_rungs_total}`);
  }
  if (facts.wheel_stage != null) {
    lines.push(`- Wheel stage: ${facts.wheel_stage} (1 = selling a cash-secured put, 2 = selling a covered call)`);
  }
  if (facts.stop_price == null && facts.wheel_stage == null && facts.ladder_rungs_total == null) {
    lines.push('- The bot has no plan recorded for this symbol yet (it may not have run on it).');
  }
  if (facts.is_excluded) {
    lines.push('- This symbol is on the bot\'s exclusion list, so the bot is set to leave it alone (no automated management).');
  }

  lines.push('');
  lines.push(`Explain this position for ${facts.symbol} now, following all the rules.`);
  return lines.join('\n');
}

/**
 * Layer-1-only fallback text, used when the LLM is unavailable. Deterministic,
 * jargon-light, never advice. Pure / testable.
 */
export function deterministicReadout(facts: PositionFacts): string {
  const unit = facts.asset_class === 'option' ? 'contract' : 'share';
  const parts: string[] = [];
  parts.push(
    `You ${facts.side === 'short' ? 'are short' : 'hold'} ${facts.qty} ${unit}${facts.qty === 1 ? '' : 's'} of ${facts.symbol} at an average cost of ${fmtUsd(facts.avg_cost)}${facts.current_price != null ? `, now ${fmtUsd(facts.current_price)}` : ''}.`,
  );
  if (facts.unrealized_pl != null) {
    const dir = facts.unrealized_pl >= 0 ? 'up' : 'down';
    const pct = facts.unrealized_pl_pct != null ? ` (${facts.unrealized_pl_pct >= 0 ? '+' : ''}${facts.unrealized_pl_pct.toFixed(2)}%)` : '';
    parts.push(`That's an unrealized (on-paper) ${dir === 'up' ? 'gain' : 'loss'} of ${fmtUsd(Math.abs(facts.unrealized_pl))}${pct}.`);
  }
  if (facts.stop_price != null) {
    parts.push(`The bot's stop is set at ${fmtUsd(facts.stop_price)} — it sells automatically if the price falls there, which would realize the loss. Trailing stop is ${facts.trailing_active ? 'on' : 'off'}.`);
  } else if (!facts.is_excluded) {
    parts.push("The bot hasn't recorded a stop for this symbol yet.");
  }
  if (facts.ladder_rungs_remaining != null && facts.ladder_rungs_total != null) {
    parts.push(`${facts.ladder_rungs_remaining} of ${facts.ladder_rungs_total} ladder add-on buys remain.`);
  }
  if (facts.wheel_stage != null) {
    parts.push(`Wheel stage ${facts.wheel_stage} (1 = cash-secured put, 2 = covered call).`);
  }
  if (facts.is_excluded) {
    parts.push('This symbol is on the exclusion list, so the bot leaves it alone.');
  }
  return parts.join(' ');
}

/** Cache signature — regenerate the explainer only when something material moves. */
export function coachSignature(facts: PositionFacts): string {
  // Round the live price to the dime so intraday ticks don't bust the cache
  // every second, but a real move still refreshes the narration.
  const px = facts.current_price == null ? 'na' : (Math.round(facts.current_price * 10) / 10).toFixed(1);
  return [
    facts.symbol,
    facts.mode,
    facts.qty,
    facts.avg_cost,
    facts.stop_price ?? 'na',
    facts.trailing_active ?? 'na',
    facts.ladder_rungs_remaining ?? 'na',
    facts.wheel_stage ?? 'na',
    px,
  ].join('|');
}

// --------------------------- data gathering ---------------------------

async function findPosition(mode: Mode, symbol: string): Promise<RawPosition | null> {
  // Read the whole positions list (same pattern as PositionContextPanel) so a
  // genuine "not held" (empty/absent) is distinguishable from an API failure
  // (which throws and surfaces as a 502 upstream, rather than a false "not held").
  const positions = await alpacaTrade<RawPosition[]>(mode, '/v2/positions');
  if (!Array.isArray(positions)) return null;
  return positions.find((p) => p.symbol === symbol) ?? null;
}

async function readBotState(mode: Mode, symbol: string): Promise<{ strat: RawStrategySym | null; wheel: RawWheelSym | null }> {
  const [strategy, wheel] = await Promise.all([
    getJson<Record<string, RawStrategySym>>(`bot:strategy:${mode}`).catch(() => null),
    getJson<Record<string, RawWheelSym>>(`bot:state:${mode}`).catch(() => null),
  ]);
  return {
    strat: strategy && typeof strategy === 'object' ? strategy[symbol] ?? null : null,
    wheel: wheel && typeof wheel === 'object' ? wheel[symbol] ?? null : null,
  };
}

// --------------------------- Claude call ---------------------------

async function callCoach(userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const client = new Anthropic({ apiKey });
  const system = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: system as never,
    messages: [{ role: 'user', content: userPrompt }] as never,
  });
  const content = resp.content as unknown;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } =>
      !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('')
    .trim();
}

// --------------------------- public entry point ---------------------------

function cacheKey(mode: Mode, symbol: string): string {
  return `position-coach:${mode}:${symbol}`;
}

export async function getOrCreateCoach(
  mode: Mode,
  symbol: string,
  opts: { refresh?: boolean } = {},
): Promise<CoachResult> {
  const position = await findPosition(mode, symbol);
  if (!position) {
    return { symbol, mode, held: false, facts: null, explainer: null, generated_at: null, cached: false };
  }

  const { strat, wheel } = await readBotState(mode, symbol);
  const facts = buildPositionFacts(symbol, mode, position, strat, wheel);
  const signature = coachSignature(facts);
  const key = cacheKey(mode, symbol);

  if (!opts.refresh) {
    const cached = await kv().get<StoredCoach>(key).catch(() => null);
    if (cached && cached.explainer && cached.signature === signature) {
      return { symbol, mode, held: true, facts, explainer: cached.explainer, generated_at: cached.generated_at, cached: true };
    }
  }

  // Layer 2 — narrate. Fail closed to the deterministic facts (explainer null →
  // the client renders deterministicReadout) so the panel is never blank.
  let explainer: string | null = null;
  let generatedAt: string | null = null;
  try {
    const text = await callCoach(buildCoachPrompt(facts));
    if (text) {
      explainer = text;
      generatedAt = new Date().toISOString();
      const stored: StoredCoach = { explainer: text, signature, generated_at: generatedAt, model: MODEL };
      await kv().set(key, stored, { ex: CACHE_TTL_SECONDS }).catch(() => {});
    }
  } catch {
    explainer = null; // degrade to deterministic readout client-side
  }

  return { symbol, mode, held: true, facts, explainer, generated_at: generatedAt, cached: false };
}
