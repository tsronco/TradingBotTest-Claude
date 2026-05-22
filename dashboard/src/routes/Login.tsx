import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDisplayName } from '../hooks/useDisplayName';

export default function Login() {
  const nav = useNavigate();
  const loc = useLocation();
  const { handle } = useDisplayName();
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
            ? 'invalid password or TOTP code.'
            : 'invalid password or backup code.'
        );
        return;
      }
      const next = (loc.state as { from?: string } | null)?.from ?? '/';
      nav(next, { replace: true });
    } catch {
      setError('network error. try again.');
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
    <div className="crt vignette dotgrid relative min-h-screen flex items-center justify-center">
      <div className="above-crt w-full max-w-md px-4">
        {/* tmux-style top accent (decorative) */}
        <div className="flex items-center gap-1.5 mb-4 text-[11px]">
          <span className="w-2 h-2 rounded-full bg-red/70" />
          <span className="w-2 h-2 rounded-full bg-amber/70" />
          <span className="w-2 h-2 rounded-full bg-hi/80 pulse" />
          <span className="text-mid ml-2">tmux</span>
          <span className="text-dim">·</span>
          <span className="text-fg">{handle}@dash</span>
          <span className="text-dim">:</span>
          <span className="text-cyan">~/portfolio</span>
        </div>

        {/* prompt header */}
        <div className="flex items-baseline gap-2 mb-2 text-[12px] flex-wrap">
          <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
          <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>
          <span className="text-fg">login</span>
          <span className="text-amber">--auth=<span className="text-fg">{mode}</span></span>
          <span className="caret" />
        </div>

        {/* title */}
        <div className="mb-5">
          <h1 className="text-hi text-[44px] font-bold leading-none tracking-tight">Sign in</h1>
          <div className="mt-2 text-mid text-[12px]">
            <span className="text-dim">[</span>
            <span className="text-fg">trading dashboard</span>
            <span className="text-dim">]</span>
            <span className="text-dim mx-2">·</span>
            <span className="text-dim">password + 2FA required</span>
          </div>
        </div>

        {/* form panel with corner ornament */}
        <form
          onSubmit={onSubmit}
          className="relative border border-border bg-panel/60 rounded-sm p-6"
          style={{ overflow: 'visible' }}
        >
          <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
            <span className="text-dim">┌──</span>
            <span className="text-hi">AUTH</span>
            <span className="text-dim">──┐</span>
          </div>

          <label className="block text-dim text-[10px] tracking-[0.2em] uppercase mb-1.5 mt-1">password</label>
          <div className="flex items-center gap-2 bg-panel-2 border border-border rounded-sm px-3 mb-4 focus-within:border-hi transition-colors">
            <span className="text-hi text-[12px]">▸</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex-1 bg-transparent py-2 text-fg text-[13px] focus:outline-none placeholder:text-dim"
            />
          </div>

          <label className="block text-dim text-[10px] tracking-[0.2em] uppercase mb-1.5">
            {mode === 'totp' ? '6-digit code' : 'backup code'}
          </label>
          <div className="flex items-center gap-2 bg-panel-2 border border-border rounded-sm px-3 mb-3 focus-within:border-hi transition-colors">
            <span className="text-hi text-[12px]">▸</span>
            {mode === 'totp' ? (
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="flex-1 bg-transparent py-2 text-fg text-[14px] focus:outline-none tracking-[0.4em] tnum placeholder:text-dim placeholder:tracking-normal"
                placeholder="000000"
              />
            ) : (
              <input
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                placeholder="K7MR-Q9XV-3LD2"
                value={totp}
                onChange={(e) => setTotp(e.target.value.trim())}
                className="flex-1 bg-transparent py-2 text-fg text-[13px] tracking-wider focus:outline-none placeholder:text-dim placeholder:tracking-normal"
              />
            )}
          </div>

          <button
            type="button"
            onClick={toggleMode}
            className="block text-dim hover:text-hi text-[11px] mb-4 transition-colors"
          >
            {mode === 'totp'
              ? '· lost your phone? use a backup code.'
              : '· back to authenticator code.'}
          </button>

          {error && (
            <div className="flex items-center gap-2 text-red text-[11px] mb-3 border border-red/40 bg-red/10 rounded-sm px-3 py-2">
              <span>✗</span>
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || password.length === 0 || !secondFactorOk}
            className="pbtn w-full !py-2 !text-[13px] !font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: submitting || password.length === 0 || !secondFactorOk ? undefined : 'rgba(34, 255, 136, 0.10)',
              borderColor: submitting || password.length === 0 || !secondFactorOk ? undefined : '#22ff88',
              color: submitting || password.length === 0 || !secondFactorOk ? undefined : '#22ff88',
            }}
          >
            {submitting ? (
              <>
                <span className="caret mr-2" />
                signing in…
              </>
            ) : (
              <>▸ sign in</>
            )}
          </button>

          {/* footer hint */}
          <div className="mt-4 text-dim text-[10px] tracking-[0.15em] uppercase flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-hi pulse rounded-sm" />
            <span>session secured · HMAC + cookie</span>
          </div>
        </form>

        {/* bottom prompt */}
        <div className="mt-4 text-[12px]">
          <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
          <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>{' '}
          <span className="caret" />
        </div>
      </div>
    </div>
  );
}
