// dashboard/src/routes/OrderNew.tsx
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { OrderHeader } from '../components/order/OrderHeader';
import { StockOrderForm } from '../components/order/StockOrderForm';
import { OptionOrderForm } from '../components/order/OptionOrderForm';
import { ConfirmModal } from '../components/order/ConfirmModal';
import type { RuleWarning } from '../lib/trade-types';

export default function OrderNew() {
  const [params] = useSearchParams();
  const [preview, setPreview] = useState<
    { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any } | null
  >(null);

  const symbol = params.get('symbol');
  const contract = params.get('contract');
  const type = params.get('type');
  const action = params.get('action') as 'open' | 'close' | null;
  const account = (params.get('account') as 'conservative_paper' | 'aggressive_paper') ?? 'conservative_paper';

  if (!symbol && !contract) {
    return (
      <div className="p-6">
        <div className="text-mid text-[12px]">
          <span className="text-cyan">tim@dash:~/portfolio$</span> pick a symbol → /lookup/SYM
        </div>
      </div>
    );
  }

  const isOption = !!contract;
  const title = isOption ? `Order — ${contract}` : `Order — ${symbol}`;
  const subtitle = `// ${isOption ? 'option' : 'stock'} · ${account}`;

  return (
    <div className="p-6 max-w-3xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/order</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">new {isOption ? `--contract=${contract} --action=${action}` : `--symbol=${symbol} --type=${type}`}</span>
      </div>
      <div className="mt-4">
        <OrderHeader title={title} subtitle={subtitle} quoteLine="loading…" positionLine={null} />
      </div>
      <div className="mt-6">
        {isOption ? (
          <OptionOrderForm contractSymbol={contract!} action={action ?? 'open'} account={account} onReview={setPreview} />
        ) : (
          <StockOrderForm symbol={symbol!} account={account} onReview={setPreview} />
        )}
      </div>
      {preview && <ConfirmModal preview={preview} onClose={() => setPreview(null)} />}

      {/* footer ribbon */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— press</span>
        <span className="text-fg border border-border px-1.5 rounded-sm">?</span>
        <span className="text-dim">for keymap</span>
      </div>

      {/* bottom prompt */}
      <div className="mt-4 text-[12px]">
        <span className="text-mid">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/order</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
  );
}
