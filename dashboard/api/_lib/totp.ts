import { authenticator } from 'otplib';

// Default window of 1 = accept previous, current, or next 30s code (≈ ±30s clock skew tolerance).
authenticator.options = { window: 1 };

export function verifyTotp(code: string, secret: string): boolean {
  if (!secret) return false;
  const cleaned = (code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return authenticator.verify({ token: cleaned, secret });
  } catch {
    return false;
  }
}
