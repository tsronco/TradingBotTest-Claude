import type { Mode } from './alpaca.js';

const DATA_BASE = 'https://data.alpaca.markets';

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
  const url = new URL(path, DATA_BASE);
  const cleanParams = Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  );
  url.search = new URLSearchParams(cleanParams).toString();
  const res = await fetch(url.toString(), {
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
