// Three accounts: manual (paper) + live (real money) + agent — the autonomous
// Claude-driven paper account (agentic trading), registered 2026-08-18. The
// conservative/aggressive/sm* accounts were retired 2026-06-29.
export type Mode = 'manual' | 'live' | 'agent';

const MODES: readonly Mode[] = ['manual', 'live', 'agent'];

export function isMode(s: unknown): s is Mode {
  return typeof s === 'string' && (MODES as readonly string[]).includes(s);
}

/** Paper modes — everything except `live`. Used by callers that need to know
 *  whether a request can reach real money. */
export function isPaperMode(mode: Mode): boolean {
  return mode !== 'live';
}

export function modeFromQuery(q: unknown): Mode {
  const v = Array.isArray(q) ? q[0] : q;
  return isMode(v) ? v : 'manual';
}

/**
 * Env var names backing each account, so a missing one can be named in the
 * error rather than leaving a generic failure to guess at.
 *
 * NOTE these must exist as **Vercel** env vars. The bots read the same-named
 * values from GitHub Actions secrets, which is a completely separate store —
 * setting one does not set the other.
 */
export const CRED_ENV_VARS: Record<Mode, { key: string; secret: string }> = {
  // live — REAL MONEY. Hits api.alpaca.markets (not paper-api).
  live:   { key: 'ALPACA_LIVE_API_KEY',   secret: 'ALPACA_LIVE_API_SECRET' },
  // agent — the autonomous Claude-driven paper MARGIN sub-account. Paper
  // endpoint, its own credential set (mirrors agent_config.py).
  agent:  { key: 'ALPACA_AGENT_API_KEY',  secret: 'ALPACA_AGENT_API_SECRET' },
  manual: { key: 'ALPACA_MANUAL_API_KEY', secret: 'ALPACA_MANUAL_API_SECRET' },
};

/**
 * Thrown when an account's Alpaca credentials are not configured.
 *
 * Distinct from a request failure on purpose: "you never set this up" and
 * "Alpaca rejected the call" need different fixes, and collapsing both into a
 * generic 502 makes a one-line configuration miss look like an outage.
 */
export class MissingCredentialsError extends Error {
  readonly mode: Mode;
  readonly missing: string[];
  constructor(mode: Mode, missing: string[]) {
    super(
      `Alpaca credentials not configured for the ${mode} account — ` +
      `set ${missing.join(' and ')} in the dashboard's Vercel environment ` +
      `(GitHub Actions secrets are a separate store and do not apply here).`,
    );
    this.name = 'MissingCredentialsError';
    this.mode = mode;
    this.missing = missing;
  }
}

function credsFor(mode: Mode): { key: string; secret: string } {
  const names = CRED_ENV_VARS[mode];
  const key = process.env[names.key];
  const secret = process.env[names.secret];
  const missing: string[] = [];
  if (!key) missing.push(names.key);
  if (!secret) missing.push(names.secret);
  if (missing.length > 0) {
    throw new MissingCredentialsError(mode, missing);
  }
  return { key: key as string, secret: secret as string };
}

/** True for the live (real-money) mode. Used by trading-API callers to
 *  switch the base URL from paper-api.alpaca.markets to api.alpaca.markets. */
export function isLiveMode(mode: Mode): boolean {
  return mode === 'live';
}

// Exported for data-api.ts so we share the cred-resolution logic in one place.
export { credsFor };

/**
 * D1 live-access guard — mirrors the submit guard in trades/[action].ts exactly.
 *
 * Call this at the top of any handler branch that would reach a live Alpaca
 * endpoint (mutations or reads). Returns true when the request should be
 * rejected and has already written a 403; returns false when the caller may
 * proceed.
 *
 * Exact semantics: mode === 'live' AND process.env.LIVE_ENABLED !== 'true'
 * → write HTTP 403 JSON { error: 'live_trading_disabled' } and return true.
 * Paper modes (any mode other than 'live') always return false (allowed).
 *
 * Usage:
 *   if (liveGuard(mode, res)) return;
 */
export function liveGuard(
  mode: Mode,
  res: { status: (code: number) => { json: (body: unknown) => void } },
): boolean {
  if (mode === 'live' && process.env.LIVE_ENABLED !== 'true') {
    res.status(403).json({ error: 'live_trading_disabled' });
    return true;
  }
  return false;
}
