/**
 * D8 — Tests for rate-limit hardening:
 *   1. clientIp uses Vercel-trusted header; forged multi-hop XFF does NOT rotate the lockout key
 *   2. Global backstop trips after threshold regardless of per-IP value
 *   3. Successful login clears both per-IP and global counters
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── KV mock ────────────────────────────────────────────────────────────────
const kvStore: Record<string, number> = {};
const kvGet  = vi.fn(async (key: string) => kvStore[key] ?? null);
const kvSet  = vi.fn(async (key: string, val: number) => { kvStore[key] = val; });
const kvDel  = vi.fn(async (...keys: string[]) => { keys.forEach(k => delete kvStore[k]); });
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, del: kvDel }) }));

beforeEach(() => {
  // reset in-memory store and call histories between tests
  Object.keys(kvStore).forEach(k => delete kvStore[k]);
  kvGet.mockClear();
  kvSet.mockClear();
  kvDel.mockClear();
});

// ── clientIp ────────────────────────────────────────────────────────────────

describe('clientIp — D8: uses Vercel-trusted header, not leftmost XFF', () => {
  it('returns x-forwarded-for value directly (Vercel sets this, cannot be prepended by client)', async () => {
    const { clientIp } = await import('../../api/_lib/rate-limit');
    // On Vercel, x-forwarded-for is a single trusted IP set by the edge network.
    // A client cannot prepend to it.
    const ip = clientIp({ 'x-forwarded-for': '1.2.3.4' });
    expect(ip).toBe('1.2.3.4');
  });

  it('uses x-real-ip as fallback when x-forwarded-for is absent', async () => {
    const { clientIp } = await import('../../api/_lib/rate-limit');
    const ip = clientIp({ 'x-real-ip': '5.6.7.8' });
    expect(ip).toBe('5.6.7.8');
  });

  it('returns "unknown" when no IP header is present', async () => {
    const { clientIp } = await import('../../api/_lib/rate-limit');
    const ip = clientIp({});
    expect(ip).toBe('unknown');
  });

  // D8 key test: a forged multi-hop XFF header like "attacker-IP, real-IP" must
  // resolve to "real-IP" (the rightmost / Vercel-trusted hop), NOT "attacker-IP".
  // Previously the code took split(',')[0] which is the leftmost (attacker-controlled) value.
  // The fix: because Vercel rewrites XFF entirely, the value will always be a single IP —
  // but if somehow a proxy prepends to it, we take the RIGHTMOST token (the trusted-proxy-added hop).
  it('resolves multi-hop XFF to the rightmost (trusted) token, not the leftmost (spoofable) token', async () => {
    const { clientIp } = await import('../../api/_lib/rate-limit');
    // An attacker sets XFF: "attacker-ip, real-ip" (comma-separated chain).
    // We must not use "attacker-ip". We must use "real-ip" (rightmost = added by trusted infra).
    const ip = clientIp({ 'x-forwarded-for': 'attacker-ip, real-ip' });
    expect(ip).not.toBe('attacker-ip');
    expect(ip).toBe('real-ip');
  });

  it('rotating the leftmost XFF no longer evades per-IP lockout: N failures from one real client accumulate', async () => {
    const { clientIp } = await import('../../api/_lib/rate-limit');
    // Simulate 5 failures where attacker rotates leftmost XFF but real IP is always "1.2.3.4"
    const realIp = '1.2.3.4';
    const attempts = [
      'evil-1, ' + realIp,
      'evil-2, ' + realIp,
      'evil-3, ' + realIp,
      'evil-4, ' + realIp,
      'evil-5, ' + realIp,
    ];
    const resolvedIps = attempts.map(xff => clientIp({ 'x-forwarded-for': xff }));
    // All should resolve to the same real IP
    expect(new Set(resolvedIps).size).toBe(1);
    expect(resolvedIps[0]).toBe(realIp);
  });
});

// ── Global backstop ──────────────────────────────────────────────────────────

describe('global backstop — D8: trips after threshold regardless of IP', () => {
  it('isGloballyRateLimited returns false when global count is below threshold', async () => {
    const { isGloballyRateLimited } = await import('../../api/_lib/rate-limit');
    kvGet.mockResolvedValueOnce(5); // below threshold
    expect(await isGloballyRateLimited()).toBe(false);
  });

  it('isGloballyRateLimited returns true at threshold (20)', async () => {
    const { isGloballyRateLimited } = await import('../../api/_lib/rate-limit');
    kvGet.mockResolvedValueOnce(20); // at threshold
    expect(await isGloballyRateLimited()).toBe(true);
  });

  it('isGloballyRateLimited returns true above threshold', async () => {
    const { isGloballyRateLimited } = await import('../../api/_lib/rate-limit');
    kvGet.mockResolvedValueOnce(21);
    expect(await isGloballyRateLimited()).toBe(true);
  });

  it('recordFailure increments the global counter key', async () => {
    const { recordFailure } = await import('../../api/_lib/rate-limit');
    kvGet.mockResolvedValue(0);
    await recordFailure('1.2.3.4');
    // Should have written to the global key
    const globalKeyWrite = kvSet.mock.calls.find(([k]) => k === 'auth:fail:global');
    expect(globalKeyWrite).toBeDefined();
  });

  it('global backstop trips after N failures from completely different IPs (spoof-resistant)', async () => {
    const { recordFailure, isGloballyRateLimited } = await import('../../api/_lib/rate-limit');
    // Simulate 20 failures from 20 different IPs (the attacker rotates IPs completely)
    // Per-IP counter would never exceed 1. But the global counter should reach 20.
    let globalCount = 0;
    kvGet.mockImplementation(async (key: string) => {
      if (key === 'auth:fail:global') return globalCount;
      return 0; // per-IP counts always 0 (different IP each time)
    });
    kvSet.mockImplementation(async (key: string, val: number) => {
      if (key === 'auth:fail:global') globalCount = val;
    });

    for (let i = 0; i < 20; i++) {
      await recordFailure(`10.0.0.${i}`); // different IP each time
    }

    // Now the global counter should be at 20 — attacker is locked out
    expect(await isGloballyRateLimited()).toBe(true);
  });
});

// ── clearFailures ────────────────────────────────────────────────────────────

describe('clearFailures — D8: clears both per-IP and global counters on success', () => {
  it('clears the per-IP key', async () => {
    const { clearFailures } = await import('../../api/_lib/rate-limit');
    await clearFailures('1.2.3.4');
    const delArgs = kvDel.mock.calls.flat();
    expect(delArgs).toContain('auth:fail:1.2.3.4');
  });

  it('clears the global key', async () => {
    const { clearFailures } = await import('../../api/_lib/rate-limit');
    await clearFailures('1.2.3.4');
    const delArgs = kvDel.mock.calls.flat();
    expect(delArgs).toContain('auth:fail:global');
  });
});
