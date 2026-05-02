import { describe, it, expect } from 'vitest';
import { authenticator } from 'otplib';
import { verifyTotp } from '../../api/_lib/totp';

describe('verifyTotp', () => {
  const secret = authenticator.generateSecret();

  it('accepts a current valid code', () => {
    const code = authenticator.generate(secret);
    expect(verifyTotp(code, secret)).toBe(true);
  });

  it('rejects garbage', () => {
    expect(verifyTotp('000000', secret)).toBe(false);
    expect(verifyTotp('abcdef', secret)).toBe(false);
    expect(verifyTotp('', secret)).toBe(false);
  });

  it('rejects when the secret is missing', () => {
    expect(verifyTotp('123456', '')).toBe(false);
  });

  it('strips whitespace from input', () => {
    const code = authenticator.generate(secret);
    expect(verifyTotp(`  ${code} `, secret)).toBe(true);
  });
});
