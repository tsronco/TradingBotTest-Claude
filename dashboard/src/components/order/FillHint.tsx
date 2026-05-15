// dashboard/src/components/order/FillHint.tsx
import { computeFillHint } from '../../lib/fillHint';
import { fmtUsd } from '../../lib/format';

interface Props {
  side: 'buy' | 'sell';
  bid: number;
  ask: number;
  last?: number;
  oi?: number;
  volume?: number;
  tick?: number;
  onPick: (price: number) => void;
}

export default function FillHint({ side, bid, ask, last, oi, volume, tick, onPick }: Props) {
  const hint = computeFillHint({ side, bid, ask, last, oi, volume, tick });

  if (!hint) {
    return (
      <div className="text-dim text-[10px] italic py-1">
        no live quote — can't suggest a price
      </div>
    );
  }

  const tiers = [hint.fast, hint.balanced, hint.patient];

  return (
    <div className="space-y-1 py-1">
      <div className="text-dim text-[10px]">
        Bid {fmtUsd(hint.bid)} · Mid {fmtUsd(hint.mid)} · Ask {fmtUsd(hint.ask)}
      </div>
      <div className="flex gap-1 flex-wrap">
        {tiers.map((tier) => (
          <button
            key={tier.label}
            type="button"
            className="pbtn max-md:min-h-[44px]"
            title={tier.note}
            onClick={() => onPick(tier.price)}
          >
            [{tier.label} {fmtUsd(tier.price)}]
          </button>
        ))}
      </div>
      <div className="text-mid text-[10px]">{hint.confidence}</div>
      <div className="text-dim text-[9px] italic">estimate — not a guarantee</div>
    </div>
  );
}
