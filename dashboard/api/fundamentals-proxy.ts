import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from './_lib/auth-guard.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const internalToken = process.env.INTERNAL_FUNCTIONS_TOKEN ?? '';
  if (!internalToken) {
    return res.status(500).json({ error: 'internal_token_not_configured' });
  }
  const symbol = String(req.query.symbol ?? '');
  // Vercel routes /api/fundamentals.py as /api/fundamentals — call it server-to-server.
  // The Python handler requires X-Internal-Auth so only this proxy can reach it.
  const url = `https://${req.headers.host}/api/fundamentals?symbol=${encodeURIComponent(symbol)}`;
  const headers: Record<string, string> = { 'X-Internal-Auth': internalToken };
  // On preview deploys with Vercel deployment-protection enabled, server-to-server
  // calls back to the same deploy hit the SSO wall and return HTML instead of JSON.
  // The "Protection Bypass for Automation" secret (auto-injected as
  // VERCEL_AUTOMATION_BYPASS_SECRET when enabled in the dashboard) bypasses that.
  // Production has no wall, so the secret is unused; preview reads it.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  const resp = await fetch(url, { headers });
  res.setHeader('Content-Type', 'application/json');
  res.status(resp.status);
  res.send(await resp.text());
}
