import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';
import type { RuleWarning } from '../../lib/trade-types';

interface Props {
  preview: { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any };
  onClose: () => void;
}

export function ConfirmModal({ preview, onClose }: Props) {
  const navigate = useNavigate();
  const { draft } = preview;
  const [totp, setTotp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overlayBorder = preview.requires_totp ? 'border-amber' : 'border-hi';
  const titleColor = preview.requires_totp ? 'text-amber' : 'text-hi';

  async function place() {
    setError(null); setSubmitting(true);
    try {
      const body = preview.requires_totp ? { ...draft, totp_code: totp } : draft;
      const res = await api<{ id: string }>('/api/trades/submit', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      navigate(`/trade/${res.id}`);
    } catch (e: any) {
      setError(e.message ?? 'submit failed.');
    } finally { setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 bg-bg/85 flex items-center justify-center p-4 z-50">
      <div className={`relative bg-panel border ${overlayBorder} max-w-md w-full`}>
        <div className="absolute -top-3 left-3 px-2 bg-panel text-[10px] tracking-[0.25em]">
          <span className="text-dim">┌──</span>{' '}
          <span className={titleColor}>{preview.requires_totp ? 'CONFIRM + TOTP' : 'CONFIRM'}</span>{' '}
          <span className="text-dim">──┐</span>
        </div>
        <div className="p-5 text-[12px]">
          <div className={`${titleColor} font-bold text-[14px]`}>review &amp; confirm</div>
          <div className="text-dim text-[10px]">
            // step {preview.requires_totp ? '2 of 2 · ≥ threshold · totp required' : '1 of 2 · below totp threshold'}
          </div>

          <div className="text-dim text-[10px] tracking-[0.25em] mt-4 mb-1">━━━ order ─────────────</div>
          <Row k="action" v={`${draft.side.toUpperCase()} ${draft.qty} ${draft.symbol}${draft.contract_symbol ? ` ${draft.contract_type?.toUpperCase()} $${draft.strike} ${draft.expiration}` : ''}`} />
          <Row k="type" v={`${draft.order_type}${draft.limit_price ? ' @ ' + fmtUsd(draft.limit_price) : ''} · ${draft.tif}`} />
          <Row k="account" v={draft.account} />
          <Row k="exposure" v={<span className={preview.requires_totp ? 'text-amber font-semibold' : 'text-fg'}>{fmtUsd(preview.exposure)}</span>} />

          <div className="text-dim text-[10px] tracking-[0.25em] mt-3 mb-1">━━━ entry grade ───────</div>
          <Row k="grade" v={<span className="text-hi font-semibold">{draft.entry_grade}</span>} />
          <div className="text-fg text-[10px] mt-1">"{draft.entry_reasoning}"</div>

          <div className="text-dim text-[10px] tracking-[0.25em] mt-3 mb-1">━━━ rule check ────────</div>
          {preview.rule_warnings.length === 0
            ? <div className="text-hi text-[10px]">▸ ok — no warnings</div>
            : preview.rule_warnings.map((w) => (
                <div key={w.rule} className={`text-[10px] ${w.severity === 'warn' ? 'text-amber' : 'text-mid'}`}>
                  ▸ {w.rule}: {w.message}
                </div>
              ))}

          {preview.requires_totp && (
            <>
              <div className="text-dim text-[10px] tracking-[0.25em] mt-3 mb-1">━━━ totp code ─────────</div>
              <div className="flex justify-center py-2">
                <input
                  type="text" inputMode="numeric"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className="bg-panel-2 border border-border px-2 py-1 text-fg text-[14px] tnum tracking-[0.4em] w-32 text-center"
                />
              </div>
            </>
          )}

          {error && <div className="text-red text-[10px] mt-2">{error}</div>}

          <div className="mt-4 flex justify-between gap-2">
            <button type="button" className="pbtn" onClick={onClose}>[back]</button>
            <div className="flex gap-2">
              <button type="button" className="pbtn" onClick={onClose}>[cancel]</button>
              <button
                type="button"
                disabled={submitting || (preview.requires_totp && totp.length !== 6)}
                onClick={place}
                className={`pbtn ${preview.requires_totp ? 'border-amber text-amber bg-amber/5' : 'active'}`}
              >
                [{submitting ? 'placing…' : preview.requires_totp ? 'verify & place*' : 'place order*'}]
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-mid">{k}</span>
      <span>{v}</span>
    </div>
  );
}
