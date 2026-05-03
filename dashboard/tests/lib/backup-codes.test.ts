import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as kvModule from '../../api/_lib/kv';

const kvGet = vi.fn();
const kvSet = vi.fn();

vi.spyOn(kvModule, 'kv').mockReturnValue({
  get: kvGet,
  set: kvSet,
  del: vi.fn(),
} as any);

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockReset();
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

  it('writes hashes to KV and clears used list', async () => {
    kvSet.mockResolvedValue('OK');
    const { regenerateBackupCodes } = await import('../../api/_lib/backup-codes');
    await regenerateBackupCodes();
    expect(kvSet).toHaveBeenCalledWith(
      'auth:backup_codes_hashed',
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)])
    );
    expect(kvSet).toHaveBeenCalledWith('auth:used-backup-codes', []);
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
      if (key === 'auth:used-backup-codes') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const result = await consumeBackupCodeIfValid(code);
    expect(result).toBe(true);
    expect(kvSet).toHaveBeenCalledWith('auth:used-backup-codes', expect.arrayContaining([hash]));
  });

  it('falls back to env var when KV is empty', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();
    process.env.BACKUP_CODES_HASHED = hash;
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve(null);
      if (key === 'auth:used-backup-codes') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const result = await consumeBackupCodeIfValid(code);
    expect(result).toBe(true);
  });

  it('rejects code not in allowed list', async () => {
    const { consumeBackupCodeIfValid } = await import('../../api/_lib/backup-codes');
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve(['some-other-hash']);
      if (key === 'auth:used-backup-codes') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const result = await consumeBackupCodeIfValid('ABCD-EFGH-IJKL');
    expect(result).toBe(false);
  });

  it('rejects already-used code', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve([hash]);
      if (key === 'auth:used-backup-codes') return Promise.resolve([hash]);   // already used
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const result = await consumeBackupCodeIfValid(code);
    expect(result).toBe(false);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('normalizes code input (strips spaces and dashes, uppercases)', async () => {
    const { generateBackupCode, consumeBackupCodeIfValid } = await import(
      '../../api/_lib/backup-codes'
    );
    const { code, hash } = generateBackupCode();
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve([hash]);
      if (key === 'auth:used-backup-codes') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const normalized = code.toLowerCase().replace(/-/g, ' ').split('').join(' ');
    const result = await consumeBackupCodeIfValid(normalized);
    expect(result).toBe(true);
  });
});
