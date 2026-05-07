import { createClient } from '@alpacahq/typescript-sdk';

export type Mode = 'conservative' | 'aggressive' | 'manual';

export function isMode(s: unknown): s is Mode {
  return s === 'conservative' || s === 'aggressive' || s === 'manual';
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
  } else {
    key = process.env.ALPACA_MANUAL_API_KEY;
    secret = process.env.ALPACA_MANUAL_API_SECRET;
  }
  if (!key || !secret) {
    throw new Error(`alpaca creds missing for mode=${mode}`);
  }
  return { key, secret };
}

export function alpacaFor(mode: Mode) {
  const { key, secret } = credsFor(mode);
  return createClient({ key, secret });
}

// Exported for data-api.ts so we share the cred-resolution logic in one place.
export { credsFor };
