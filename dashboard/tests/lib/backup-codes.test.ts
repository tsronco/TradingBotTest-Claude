import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as kvModule from '../../api/_lib/kv';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvSadd = vi.fn();
const kvDel = vi.fn();

vi.spyOn(kvModule, 'kv').mockReturnValue({
  get: kvGet,
  set: kvSet,
  del: kvDel,
  sadd: kvSadd,
} as any);

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockReset();
  kvSadd.mockReset();
  kvDel.mockReset();
  process.env.BACKUP_CODES_HASHED = '';
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generateBackupCode', () => {
  it('generates a code with dashes at positions 4 and 8', async () => {
    const { generateBackupCode } = await import('../../api/_lib/backup-codes');
    const { code } = generateBackupCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('never generates with confusing chars (0, O, 1, I)', async () => {
    const { generateBackupCode } = await import('../../api/_lib/backup-codes');
    for (let i = 0; i < 20; i++) {
      const { code } = generateBackupCode();
      expect(code).not.toMatch(/[0O1I]/);
    }
  });

  it('returns a hash', async () => {
    const { generateBackupCode } = await import('../../api/_lib/backup-codes');
    const { hash } = generateBackupCode();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);   // SHA-256 hex
  });
});

describe('looksLikeBackupCode', () => {
  it('accepts code-like strings', async () => {
    const { looksLikeBackupCode } = await import('../../api/_lib/backup-codes');
    expect(looksLikeBackupCode('ABCD-EFGH-IJKL')).toBe(true);
    expect(looksLikeBackupCode('ABCDEFGHIJKL')).toBe(true);
    expect(looksLikeBackupCode('abcd-efgh-ijkl')).toBe(true);
  });

  it('rejects 6-digit TOTP codes', async () => {
    const { looksLikeBackupCode } = await import('../../api/_lib/backup-codes');
    expect(looksLikeBackupCode('123456')).toBe(false);
    expect(looksLikeBackupCode('000000')).toBe(false);
  });

  it('rejects too-short input', async () => {
    const { looksLikeBackupCode } = await import('../../api/_lib/backup-codes');
    expect(looksLikeBackupCode('12345')).toBe(false);
  });
});

describe('regenerateBackupCodes', () => {
  it('generates 8 fresh codes and hashes', async () => {
    kvSet.mockResolvedValue('OK');
    const { regenerateBackupCodes } = await import('../../api/_lib/backup-codes');
    const result = await regenerateBackupCodes();
    expect(result.codes).toHaveLength(8);
    result.codes.forEach((code) => {
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });
  });

  it('writes hashes to KV and clears used-code keys', async () => {
    kvSet.mockResolvedValue('OK');
    kvDel.mockResolvedValue(1);
    const { regenerateBackupCodes } = await import('../../api/_lib/backup-codes');
    await regenerateBackupCodes();
    expect(kvSet).toHaveBeenCalledWith(
      'auth:backup_codes_hashed',
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)])
    );
    // The old JSON-array key and the new SET key are both deleted on rotation.
    expect(kvDel).toHaveBeenCalledWith('auth:used-backup-codes');
    expect(kvDel).toHaveBeenCalledWith('auth:used-backup-codes:v2');
  });

  it('returns plaintext codes (not hashes)', async () => {
    kvSet.mockResolvedValue('OK');
    const { regenerateBackupCodes } = await import('../../api/_lib/backup-codes');
    const result = await regenerateBackupCodes();
    result.codes.forEach((code) => {
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(code.length).toBe(14);   // 12 chars + 2 dashes
    });
  });
});

describe('consumeBackupCodeIfValid (KV-first behavior)', () => {
  it('uses KV hashes when present, ignores env var', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();
    process.env.BACKUP_CODES_HASHED = 'env-bogus-hash';
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve([hash]);
      // No old-array used entry; sadd handles the v2 set.
      return Promise.resolve(null);
    });
    // sadd returns 1 = newly added (first use of this code).
    kvSadd.mockResolvedValue(1);
    const result = await consumeBackupCodeIfValid(code);
    expect(result).toBe(true);
    // Consumption happens via atomic sadd, not set.
    expect(kvSadd).toHaveBeenCalledWith('auth:used-backup-codes:v2', hash);
    expect(kvSet).not.toHaveBeenCalledWith('auth:used-backup-codes', expect.anything());
  });

  it('falls back to env var when KV is empty', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();
    process.env.BACKUP_CODES_HASHED = hash;
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    kvSadd.mockResolvedValue(1);
    const result = await consumeBackupCodeIfValid(code);
    expect(result).toBe(true);
  });

  it('rejects code not in allowed list', async () => {
    const { consumeBackupCodeIfValid } = await import('../../api/_lib/backup-codes');
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve(['some-other-hash']);
      return Promise.resolve(null);
    });
    kvSadd.mockResolvedValue(1);
    const result = await consumeBackupCodeIfValid('ABCD-EFGH-IJKL');
    expect(result).toBe(false);
    // Should never reach sadd — rejected before consumption attempt.
    expect(kvSadd).not.toHaveBeenCalled();
  });

  it('rejects code already recorded in v2 SET (sadd returns 0)', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve([hash]);
      return Promise.resolve(null);
    });
    // sadd returns 0 = hash was already in the set → previously consumed.
    kvSadd.mockResolvedValue(0);
    const result = await consumeBackupCodeIfValid(code);
    expect(result).toBe(false);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('rejects code already in legacy JSON-array (migration path)', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve([hash]);
      if (key === 'auth:used-backup-codes') return Promise.resolve([hash]); // old array has it
      return Promise.resolve(null);
    });
    kvSadd.mockResolvedValue(1); // v2 SET doesn't have it yet
    const result = await consumeBackupCodeIfValid(code);
    // Must reject because the old array shows it was used.
    expect(result).toBe(false);
    expect(kvSadd).not.toHaveBeenCalled();
  });

  it('normalizes code input (strips spaces and dashes, uppercases)', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve([hash]);
      return Promise.resolve(null);
    });
    kvSadd.mockResolvedValue(1);
    const normalized = code.toLowerCase().replace(/-/g, ' ').split('').join(' ');
    const result = await consumeBackupCodeIfValid(normalized);
    expect(result).toBe(true);
  });
});

describe('D3 — concurrent backup-code consumption (single-use atomicity)', () => {
  it('two concurrent calls with the same valid unused code: exactly one wins', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();

    // Allowed list has the code.
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve([hash]);
      return Promise.resolve(null);
    });

    // Atomic mock: the FIRST sadd call wins (returns 1); subsequent ones lose (return 0).
    // This models a real Redis SADD that is atomic — only one concurrent writer succeeds.
    let saddCount = 0;
    kvSadd.mockImplementation(() => {
      saddCount += 1;
      return Promise.resolve(saddCount === 1 ? 1 : 0);
    });

    // Fire both "concurrent" calls before either awaits the other.
    const [r1, r2] = await Promise.all([
      consumeBackupCodeIfValid(code),
      consumeBackupCodeIfValid(code),
    ]);

    const trueCount = [r1, r2].filter(Boolean).length;
    expect(trueCount).toBe(1);   // exactly one succeeds
    expect([r1, r2].filter((v) => !v).length).toBe(1);   // exactly one fails
  });
});
