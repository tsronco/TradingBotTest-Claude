export type Mode =
  | 'conservative' | 'aggressive' | 'manual' | 'live'
  | 'sm500' | 'sm1000' | 'sm2000';

export function isMode(s: unknown): s is Mode {
  return (
    s === 'conservative' || s === 'aggressive' || s === 'manual' || s === 'live' ||
    s === 'sm500' || s === 'sm1000' || s === 'sm2000'
  );
}

export function modeFromQuery(q: unknown): Mode {
  const v = Array.isArray(q) ? q[0] : q;
  return isMode(v) ? v : 'conservative';
}

function credsFor(mode: Mode): { key: string; secret: string } {
  let key: string | undefined;
  let secret: string | undefined;
  if (mode === 'conservative') {
    key = process.env.ALPACA_API_KEY;
    secret = process.env.ALPACA_API_SECRET;
  } else if (mode === 'aggressive') {
    key = process.env.ALPACA_AGG_API_KEY;
    secret = process.env.ALPACA_AGG_API_SECRET;
  } else if (mode === 'manual') {
    key = process.env.ALPACA_MANUAL_API_KEY;
    secret = process.env.ALPACA_MANUAL_API_SECRET;
  } else if (mode === 'sm500') {
    key = process.env.ALPACA_SM500_API_KEY;
    secret = process.env.ALPACA_SM500_API_SECRET;
  } else if (mode === 'sm1000') {
    key = process.env.ALPACA_SM1000_API_KEY;
    secret = process.env.ALPACA_SM1000_API_SECRET;
  } else if (mode === 'sm2000') {
    key = process.env.ALPACA_SM2000_API_KEY;
    secret = process.env.ALPACA_SM2000_API_SECRET;
  } else {
    // live — REAL MONEY. Hits api.alpaca.markets (not paper-api).
    key = process.env.ALPACA_LIVE_API_KEY;
    secret = process.env.ALPACA_LIVE_API_SECRET;
  }
  if (!key || !secret) {
    throw new Error(`alpaca creds missing for mode=${mode}`);
  }
  return { key, secret };
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
