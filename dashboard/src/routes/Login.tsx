import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

export default function Login() {
  const nav = useNavigate();
  const loc = useLocation();
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, totp }),
      });
      if (!res.ok) {
        setError(
          mode === 'totp'
            ? 'Invalid password or TOTP code.'
            : 'Invalid password or backup code.'
        );
        return;
      }
      const next = (loc.state as any)?.from ?? '/';
      nav(next, { replace: true });
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function toggleMode() {
    setMode((m) => (m === 'totp' ? 'backup' : 'totp'));
    setTotp('');
    setError(null);
  }

  const secondFactorOk =
    mode === 'totp' ? totp.length === 6 : totp.length >= 10;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <form
        onSubmit={onSubmit}
        className="bg-panel border border-border rounded-xl p-8 w-full max-w-sm"
      >
        <h1 className="text-text-strong text-xl font-bold mb-1">Sign in</h1>
        <p className="text-muted text-xs mb-6">Trading Dashboard</p>

        <label className="block text-muted text-xs mb-1">Password</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-bg border border-border rounded-md px-3 py-2 text-text mb-4 focus:outline-none focus:border-accent"
        />

        <label className="block text-muted text-xs mb-1">
          {mode === 'totp' ? '6-digit code' : 'Backup code'}
        </label>
        {mode === 'totp' ? (
          <input
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="one-time-code"
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-full bg-bg border border-border rounded-md px-3 py-2 text-text mb-2 focus:outline-none focus:border-accent tracking-widest"
          />
        ) : (
          <input
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            placeholder="K7MR-Q9XV-3LD2"
            value={totp}
            onChange={(e) => setTotp(e.target.value.trim())}
            className="w-full bg-bg border border-border rounded-md px-3 py-2 text-text mb-2 focus:outline-none focus:border-accent"
          />
        )}

        <button
          type="button"
          onClick={toggleMode}
          className="block text-muted hover:text-accent text-xs mb-4 underline-offset-2 hover:underline"
        >
          {mode === 'totp'
            ? 'Lost your phone? Use a backup code.'
            : 'Back to authenticator code.'}
        </button>

        {error && (
          <div className="text-red text-xs mb-3">{error}</div>
        )}

        <button
          type="submit"
          disabled={submitting || password.length === 0 || !secondFactorOk}
          className="w-full bg-accent/90 hover:bg-accent text-bg font-semibold rounded-md py-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
