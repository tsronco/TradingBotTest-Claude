import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvDel = vi.fn();
const verifyTotpMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, del: kvDel }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: (...args: any[]) => verifyTotpMock(...args) }));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvDel.mockReset(); verifyTotpMock.mockReset();
  kvDel.mockResolvedValue(1);
  process.env.TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
});

function mockReq(method: string, body?: any): VercelRequest {
  return { method, query: { resource: 'backup-codes' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/settings/backup-codes', () => {
  it('rejects missing TOTP', async () => {
    verifyTotpMock.mockReturnValue(false);
    const handler = (await import('../../api/settings/[resource]')).default;
    const res = mockRes();
    await handler(mockReq('POST', {}), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 8 plaintext codes when TOTP is valid', async () => {
    verifyTotpMock.mockReturnValue(true);
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const res = mockRes();
    await handler(mockReq('POST', { totp_code: '123456' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const json = (res.json as any).mock.calls[0][0];
    expect(json.codes).toHaveLength(8);
  });
});
