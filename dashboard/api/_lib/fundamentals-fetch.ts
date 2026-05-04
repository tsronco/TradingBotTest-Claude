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
