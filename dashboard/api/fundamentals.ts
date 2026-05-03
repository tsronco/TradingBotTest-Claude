import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from './_lib/auth-guard.js';

// Fundamentals + earnings via Finnhub (free tier: 60 calls/min). Replaces the
// previous yfinance-based Python implementation, which broke when Yahoo's
// undocumented endpoints stopped returning JSON (yfinance crashed with
// "Expecting value: line 1 column 1 (char 0)").
//
// Required env var: FINNHUB_API_KEY (free at finnhub.io/register).
// Without it the endpoint returns a clear actionable message that the panels
// surface to the user instead of rendering blank.

interface FinnhubProfile {
  marketCapitalization?: number; // in millions
  finnhubIndustry?: string;
  exchange?: string;
}

interface FinnhubMetric {
  metric?: {
    peNormalizedAnnual?: number;
    peTTM?: number;
    peBasicExclExtraTTM?: number;
    '52WeekLow'?: number;
    '52WeekHigh'?: number;
    [key: string]: unknown;
  };
}

interface FinnhubEarning {
  actual: number | null;
  estimate: number | null;
  surprise: number | null;
  surprisePercent: number | null;
  period: string;        // e.g. '2024-09-30'
  symbol: string;
  year: number;
  quarter: number;
}

interface FinnhubEarningsCalendar {
  earningsCalendar?: Array<{
    date: string;
    epsActual: number | null;
    epsEstimate: number | null;
    symbol: string;
  }>;
}

async function finnhub<T>(path: string, apiKey: string): Promise<T | null> {
  const url = `https://finnhub.io/api/v1${path}${path.includes('?') ? '&' : '?'}token=${apiKey}`;
  try {
    const resp = await fetch(url, {
      // Finnhub is fast, but be defensive — if it slows we want to fail clean.
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;

  const apiKey = process.env.FINNHUB_API_KEY ?? '';
  if (!apiKey) {
    return res.status(200).json({
      error: 'finnhub_not_configured',
      message: 'Add FINNHUB_API_KEY to Vercel env vars to enable earnings + fundamentals (free at finnhub.io/register).',
      symbol: String(req.query.symbol ?? '').toUpperCase(),
      fundamentals: {},
      earnings: [],
    });
  }

  const symbol = String(req.query.symbol ?? '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }

  // Fetch profile, metrics, and earnings in parallel — Finnhub charges 1 call
  // per request and free tier allows 60/min, so the burst of 3 is fine.
  const [profile, metrics, earnings, calendar] = await Promise.all([
    finnhub<FinnhubProfile>(`/stock/profile2?symbol=${symbol}`, apiKey),
    finnhub<FinnhubMetric>(`/stock/metric?symbol=${symbol}&metric=all`, apiKey),
    finnhub<FinnhubEarning[]>(`/stock/earnings?symbol=${symbol}&limit=8`, apiKey),
    // Calendar window: 30 days back to 90 days forward catches the next confirmed
    // earnings date for almost any active ticker.
    finnhub<FinnhubEarningsCalendar>(
      `/calendar/earnings?from=${dateNDaysFromNow(-30)}&to=${dateNDaysFromNow(90)}&symbol=${symbol}`,
      apiKey,
    ),
  ]);

  const m = metrics?.metric ?? {};
  const peRatio = m.peTTM ?? m.peBasicExclExtraTTM ?? m.peNormalizedAnnual ?? null;

  // Find next upcoming earnings date from the calendar (no actual yet).
  const nowMs = Date.now();
  const upcoming = (calendar?.earningsCalendar ?? [])
    .filter((e) => e.epsActual == null && new Date(e.date).getTime() >= nowMs - 86400000)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())[0];

  // Map historical earnings to the same shape the EarningsPanel expects.
  // Finnhub returns most-recent-first; the panel sorts ascending and keeps last 4.
  const earningsList = (earnings ?? []).map((e) => ({
    date: e.period,
    eps_estimate: e.estimate,
    reported_eps: e.actual,
    surprise_pct: e.surprisePercent,
  }));

  return res.status(200).json({
    symbol,
    fundamentals: {
      // Finnhub returns market cap in millions; convert to absolute dollars to
      // match what the FundamentalsPanel expects (it divides by 1e9).
      market_cap: profile?.marketCapitalization ? profile.marketCapitalization * 1_000_000 : null,
      pe_ratio: peRatio,
      sector: profile?.finnhubIndustry ?? null,
      industry: profile?.finnhubIndustry ?? null,
      fifty_two_week_low: m['52WeekLow'] ?? null,
      fifty_two_week_high: m['52WeekHigh'] ?? null,
      next_earnings_date: upcoming ? Math.floor(new Date(upcoming.date).getTime() / 1000) : null,
    },
    earnings: earningsList,
  });
}

function dateNDaysFromNow(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}
