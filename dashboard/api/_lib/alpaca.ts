import { createClient } from '@alpacahq/typescript-sdk';

export type Mode = 'conservative' | 'aggressive' | 'manual' | 'live';

export function isMode(s: unknown): s is Mode {
  return s === 'conservative' || s === 'aggressive' || s === 'manual' || s === 'live';
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

export function alpacaFor(mode: Mode) {
  const { key, secret } = credsFor(mode);
  // The SDK defaults to paper. For live, opt out of paper so the SDK's
  // baked-in trading hostname flips to api.alpaca.markets.
  return createClient({ key, secret, paper: !isLiveMode(mode) });
}

// Exported for data-api.ts so we share the cred-resolution logic in one place.
export { credsFor };
