import type { Mode } from './alpaca.js';

const DATA_BASE = 'https://data.alpaca.markets';
const TRADING_BASE_PAPER = 'https://paper-api.alpaca.markets';

function credsFor(mode: Mode): { key: string; secret: string } {
  const key = mode === 'conservative'
    ? process.env.ALPACA_API_KEY
    : process.env.ALPACA_AGG_API_KEY;
  const secret = mode === 'conservative'
    ? process.env.ALPACA_API_SECRET
    : process.env.ALPACA_AGG_API_SECRET;
  if (!key || !secret) throw new Error(`alpaca creds missing for mode=${mode}`);
  return { key, secret };
}

function buildUrl(base: string, path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(path, base);
  const cleanParams = Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  );
  url.search = new URLSearchParams(cleanParams).toString();
  return url.toString();
}

/**
 * Direct call to the Alpaca data API. Bypasses @alpacahq/typescript-sdk
 * because that SDK's request() ignores per-request baseURL overrides
 * (https://github.com/alpacahq/typescript-sdk — bug as of v0.0.32-preview).
 */
export async function alpacaData<T>(
  mode: Mode,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const { key, secret } = credsFor(mode);
  const res = await fetch(buildUrl(DATA_BASE, path, params), {
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`alpaca data ${res.status} on ${path}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Direct call to the Alpaca trading API (paper). Same auth pattern as
 * `alpacaData` but hits paper-api.alpaca.markets. Use this when the SDK
 * either doesn't expose a trading endpoint or paginates it poorly — e.g.
 * `getOptionsContracts` strips `next_page_token` from its return shape so
 * the caller can't iterate beyond page 1 (which holds only the nearest
 * expiration for liquid underlyings like TSLA).
 */
export async function alpacaTrade<T>(
  mode: Mode,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const { key, secret } = credsFor(mode);
  const res = await fetch(buildUrl(TRADING_BASE_PAPER, path, params), {
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`alpaca trade ${res.status} on ${path}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface AlpacaTradeMutationOptions {
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
}

/**
 * Direct call to Alpaca trading API for non-GET requests (PATCH/DELETE/POST).
 * Used for order modify/cancel where the SDK is either incomplete or buggy.
 */
export async function alpacaTradeMutation<T>(
  mode: Mode,
  path: string,
  opts: AlpacaTradeMutationOptions
): Promise<T> {
  const { key, secret } = credsFor(mode);
  const init: RequestInit = {
    method: opts.method,
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret,
      'Content-Type': 'application/json',
    },
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const res = await fetch(`${TRADING_BASE_PAPER}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`alpaca trade ${res.status} on ${path}: ${body || res.statusText}`);
  }
  // DELETE often returns empty body; tolerate that.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}
