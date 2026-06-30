import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface Props {
  order: {
    id: string;
    qty: string;
    limit_price: string | null;
    stop_price: string | null;
  };
  mode: 'manual' | 'live';
  onClose: () => void;
}

export function OrderEditModal({ order, mode, onClose }: Props) {
  const qc = useQueryClient();
  const [qty, setQty] = useState(Number(order.qty));
  const [limitPrice, setLimitPrice] = useState<number | ''>(
    order.limit_price ? Number(order.limit_price) : '',
  );
  const [stopPrice, setStopPrice] = useState<number | ''>(
    order.stop_price ? Number(order.stop_price) : '',
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/alpaca/modify-order?mode=${mode}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message ?? 'modify failed.'),
  });

  function handleSave() {
    const body: Record<string, unknown> = { order_id: order.id, qty };
    if (limitPrice !== '') body.limit_price = limitPrice;
    if (stopPrice !== '') body.stop_price = stopPrice;
    save.mutate(body);
  }

  return (
    <div className="fixed inset-0 bg-bg/85 flex items-center justify-center p-4 z-50">
      <div className="relative bg-panel border border-amber max-w-md w-full mx-3 max-h-[90vh] overflow-y-auto">
        <div className="absolute -top-3 left-3 px-2 bg-panel text-[10px] tracking-[0.25em]">
          <span className="text-dim">┌──</span>{' '}
          <span className="text-amber">MODIFY ORDER</span>{' '}
          <span className="text-dim">──┐</span>
        </div>
        <div className="p-5 text-[12px]">
          <div className="text-amber font-bold text-[14px]">
            modify order{' '}
            <span className="text-dim font-normal">{order.id.slice(0, 8)}</span>
          </div>
          <div className="text-dim text-[10px] mb-4">// edit fields below and save</div>

          <div className="space-y-2">
            <Row label="qty">
              <input
                type="number"
                value={qty}
                min={1}
                step={1}
                onChange={(e) => setQty(Number(e.target.value))}
                className="bg-panel-2 border border-border px-2 py-0.5 w-full md:w-24 text-right tnum text-fg text-[12px] max-md:min-h-[44px]"
              />
            </Row>
            <Row label="limit price">
              <input
                type="number"
                step={0.01}
                value={limitPrice}
                placeholder="—"
                onChange={(e) =>
                  setLimitPrice(e.target.value === '' ? '' : Number(e.target.value))
                }
                className="bg-panel-2 border border-border px-2 py-0.5 w-full md:w-24 text-right tnum text-fg text-[12px] max-md:min-h-[44px]"
              />
            </Row>
            {order.stop_price && (
              <Row label="stop price">
                <input
                  type="number"
                  step={0.01}
                  value={stopPrice}
                  placeholder="—"
                  onChange={(e) =>
                    setStopPrice(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  className="bg-panel-2 border border-border px-2 py-0.5 w-full md:w-24 text-right tnum text-fg text-[12px] max-md:min-h-[44px]"
                />
              </Row>
            )}
          </div>

          {error && <div className="text-red text-[10px] mt-2">{error}</div>}

          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="pbtn max-md:min-h-[44px]" onClick={onClose}>
              [cancel]
            </button>
            <button
              type="button"
              className="pbtn active max-md:min-h-[44px]"
              onClick={handleSave}
              disabled={save.isPending}
            >
              [{save.isPending ? 'saving…' : 'save*'}]
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 md:flex-row md:justify-between md:items-center">
      <span className="text-mid">{label}</span>
      {children}
    </div>
  );
}
