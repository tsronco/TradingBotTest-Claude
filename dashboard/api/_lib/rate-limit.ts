import { kv } from './kv.js';

const WINDOW_SECONDS = 60 * 15;   // 15 minutes
const MAX_FAILURES = 5;

// D8: Global backstop — defeats IP-rotation spoofing completely.
// After GLOBAL_MAX_FAILURES across ALL IPs within the window, lock everyone out.
// Sane threshold for a single-user app: 20 failures / 15 min.
const GLOBAL_KEY = 'auth:fail:global';
const GLOBAL_MAX_FAILURES = 20;

function failKey(ip: string): string {
  return `auth:fail:${ip}`;
}

export async function isRateLimited(ip: string): Promise<boolean> {
  const count = await kv().get<number>(failKey(ip));
  return (count ?? 0) >= MAX_FAILURES;
}

// D8: Check the global backstop regardless of per-IP state.
export async function isGloballyRateLimited(): Promise<boolean> {
  const count = await kv().get<number>(GLOBAL_KEY);
  return (count ?? 0) >= GLOBAL_MAX_FAILURES;
}

export async function recordFailure(ip: string): Promise<void> {
  const r = kv();
  // Increment per-IP counter (sliding window).
  const perIpKey = failKey(ip);
  const perIpNext = ((await r.get<number>(perIpKey)) ?? 0) + 1;
  await r.set(perIpKey, perIpNext, { ex: WINDOW_SECONDS });

  // D8: Also increment the global counter (sliding window, same TTL).
  // This counter is unaffected by IP rotation — every failure from any IP increments it.
  const globalNext = ((await r.get<number>(GLOBAL_KEY)) ?? 0) + 1;
  await r.set(GLOBAL_KEY, globalNext, { ex: WINDOW_SECONDS });
}

export async function clearFailures(ip: string): Promise<void> {
  // D8: Clear both per-IP and global counters on successful login.
  await kv().del(failKey(ip), GLOBAL_KEY);
}

// D8: clientIp — derive the trusted client IP from Vercel-controlled headers.
//
// Vercel documents that it REWRITES x-forwarded-for and "does not forward
// external IPs — this restriction is in place to prevent IP spoofing."
// So on Vercel, x-forwarded-for is already the trusted client IP (a single value).
//
// However, if an additional non-Vercel proxy sits in front (non-Enterprise setup),
// the header may contain a comma-separated chain where the client can prepend values.
// In that case, the RIGHTMOST token is the one added by the nearest trusted proxy —
// not the leftmost (which is the client-controlled value).
//
// We use the rightmost token of x-forwarded-for, falling back to x-real-ip.
// On vanilla Vercel (the deployment target here) there is exactly one token and
// rightmost == leftmost == the real IP. Under a proxy chain the rightmost is trusted.
export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    // Take the RIGHTMOST token — the trusted-proxy-added hop.
    const tokens = xff.split(',');
    return tokens[tokens.length - 1].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    const last = xff[xff.length - 1];
    const tokens = String(last).split(',');
    return tokens[tokens.length - 1].trim();
  }
  const real = headers['x-real-ip'];
  return typeof real === 'string' && real.trim() ? real.trim() : 'unknown';
}
