// dashboard/src/routes/OrderNew.tsx
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { StockOrderForm } from '../components/order/StockOrderForm';
import { OptionOrderForm } from '../components/order/OptionOrderForm';
import { SpreadOrderForm } from '../components/order/SpreadOrderForm';
import { ConfirmModal } from '../components/order/ConfirmModal';
import type { RuleWarning, SpreadType } from '../lib/trade-types';
import { useDisplayName } from '../hooks/useDisplayName';

const VALID_SPREAD_TYPES: ReadonlySet<SpreadType> = new Set<SpreadType>([
  'put_credit', 'put_debit', 'call_credit', 'call_debit',
]);

export default function OrderNew() {
  const [params] = useSearchParams();
  const { handle } = useDisplayName();
  const [preview, setPreview] = useState<
    { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any } | null
  >(null);

  const symbol = params.get('symbol');
  const contract = params.get('contract');
  const type = params.get('type');
  const action = params.get('action') as 'open' | 'close' | null;
  type OrderAccount = 'manual_paper' | 'live';
  const initialAccount = (params.get('account') as OrderAccount) ?? 'manual_paper';
  const [account, setAccount] = useState<OrderAccount>(initialAccount);

  if (!symbol && !contract) {
    return (
      <div className="p-3 md:p-6">
        <div className="text-mid text-[12px]">
          <span className="text-cyan">{handle}@dash:~/portfolio$</span> pick a symbol → /lookup/SYM
        </div>
      </div>
    );
  }

  const spreadParam = params.get('spread') as SpreadType | null;
  const isSpread = !!spreadParam && VALID_SPREAD_TYPES.has(spreadParam);
  const isOption = !isSpread && !!contract;

  const flag = isSpread
    ? `--spread=${spreadParam} --symbol=${symbol}`
    : isOption
    ? `--contract=${contract} --action=${action}`
    : `--symbol=${symbol} --type=${type}`;

  return (
    <div className="p-3 md:p-6 max-w-3xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/order</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">new {flag}</span>
      </div>
      <div className="mt-6">
        {isSpread ? (
          <SpreadOrderForm
            symbol={symbol!}
            account={account}
            setAccount={setAccount}
            onReview={setPreview}
            spreadType={spreadParam ?? 'put_credit'}
          />
        ) : isOption ? (
          <OptionOrderForm
            contractSymbol={contract!}
            action={action ?? 'open'}
            account={account}
            setAccount={setAccount}
            onReview={setPreview}
            initialSide={params.get('side') as 'BTO' | 'STO' | 'BTC' | 'STC' | null}
            initialPrice={params.get('price') ? Number(params.get('price')) : null}
          />
        ) : (
          <StockOrderForm symbol={symbol!} account={account} setAccount={setAccount} onReview={setPreview} />
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
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/order</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
  );
}
