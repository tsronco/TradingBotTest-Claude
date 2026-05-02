import { kv } from './kv';

const WINDOW_SECONDS = 60 * 15;   // 15 minutes
const MAX_FAILURES = 5;

function failKey(ip: string): string {
  return `auth:fail:${ip}`;
}

export async function isRateLimited(ip: string): Promise<boolean> {
  const count = await kv().get<number>(failKey(ip));
  return (count ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(ip: string): Promise<void> {
  const key = failKey(ip);
  // Increment + reset TTL each failure → window slides on continued attempts.
  const next = ((await kv().get<number>(key)) ?? 0) + 1;
  await kv().set(key, next, { ex: WINDOW_SECONDS });
}

export async function clearFailures(ip: string): Promise<void> {
  await kv().del(failKey(ip));
}

export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  // Vercel forwards client IP via x-forwarded-for; first hop is the real client.
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  if (Array.isArray(xff)) return String(xff[0]).split(',')[0].trim();
  const real = headers['x-real-ip'];
  return typeof real === 'string' ? real : 'unknown';
}
