export interface ParsedOption {
  underlying: string;
  expiration: string;        // YYYY-MM-DD
  type: 'call' | 'put';
  strike: number;
}

/**
 * Parse an OCC-formatted option symbol like "BAC260522P00050000".
 * Format: <underlying (1-6 chars)><YYMMDD><C|P><strike * 1000, 8-digit padded>
 * Returns null if not a valid OCC symbol.
 */
export function parseOptionSymbol(sym: string): ParsedOption | null {
  // Match: 1-6 letters + 6 digits date + C/P + 8 digits strike
  const m = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  const [, underlying, date, type, strikeRaw] = m;
  const expiration = `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`;
  const strike = parseInt(strikeRaw, 10) / 1000;
  return {
    underlying,
    expiration,
    type: type === 'C' ? 'call' : 'put',
    strike,
  };
}

/**
 * Days remaining until the option expires.
 * Negative if already past expiration. 0 if expires today.
 *
 * Computed at calendar-day granularity using ET (the market timezone),
 * so "today" is always 0 regardless of the time of day.
 */
export function daysToExpiration(expirationISO: string, now: Date = new Date()): number {
  // Convert `now` to a YYYY-MM-DD string in ET (market timezone),
  // then diff calendar days against the expiration date.
  const nowET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const todayUTC = Date.UTC(nowET.getFullYear(), nowET.getMonth(), nowET.getDate());

  const [y, m, d] = expirationISO.split('-').map((s) => parseInt(s, 10));
  const expUTC = Date.UTC(y, m - 1, d);

  return Math.round((expUTC - todayUTC) / (1000 * 60 * 60 * 24));
}
