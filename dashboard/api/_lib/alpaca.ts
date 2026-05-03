import { createClient } from '@alpacahq/typescript-sdk';

export type Mode = 'conservative' | 'aggressive';

export function isMode(s: unknown): s is Mode {
  return s === 'conservative' || s === 'aggressive';
}

export function modeFromQuery(q: unknown): Mode {
  const v = Array.isArray(q) ? q[0] : q;
  return isMode(v) ? v : 'conservative';
}

export function alpacaFor(mode: Mode) {
  const key = mode === 'conservative'
    ? process.env.ALPACA_API_KEY
    : process.env.ALPACA_AGG_API_KEY;
  const secret = mode === 'conservative'
    ? process.env.ALPACA_API_SECRET
    : process.env.ALPACA_AGG_API_SECRET;
  if (!key || !secret) {
    throw new Error(`alpaca creds missing for mode=${mode}`);
  }
  return createClient({ key, secret });
}
