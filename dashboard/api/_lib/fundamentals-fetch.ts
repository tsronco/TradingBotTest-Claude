export async function fetchEarningsDate(symbol: string): Promise<string | null> {
  try {
    const internalToken = process.env.INTERNAL_FUNCTIONS_TOKEN ?? '';
    if (!internalToken) return null;
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';
    const headers: Record<string, string> = { 'X-Internal-Auth': internalToken };
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;
    const res = await fetch(`${baseUrl}/api/fundamentals?symbol=${encodeURIComponent(symbol)}`, { headers });
    if (!res.ok) return null;
    const data = await res.json() as { next_earnings_date?: string };
    return data.next_earnings_date ?? null;
  } catch {
    return null;
  }
}

export interface EarningsEntry {
  date: string;
}

export async function fetchEarningsDates(symbol: string): Promise<EarningsEntry[]> {
  try {
    const internalToken = process.env.INTERNAL_FUNCTIONS_TOKEN ?? '';
    if (!internalToken) return [];
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';
    const headers: Record<string, string> = { 'X-Internal-Auth': internalToken };
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;
    const res = await fetch(`${baseUrl}/api/fundamentals?symbol=${encodeURIComponent(symbol)}`, { headers });
    if (!res.ok) return [];
    const data = await res.json() as { earnings?: Array<{ date?: string }> };
    if (!Array.isArray(data.earnings)) return [];
    return data.earnings
      .filter((e): e is { date: string } => typeof e.date === 'string' && e.date.length > 0)
      .map((e) => ({ date: e.date }));
  } catch {
    return [];
  }
}

/** True if any earnings date lies in [from, to] inclusive. Pure / unit-testable. */
export function earningsInWindow(
  dates: EarningsEntry[],
  from: string,
  to: string,
): boolean {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
  for (const e of dates) {
    const ms = Date.parse(e.date);
    if (!Number.isFinite(ms)) continue;
    if (ms >= fromMs && ms <= toMs) return true;
  }
  return false;
}
