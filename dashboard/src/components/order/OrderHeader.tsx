// dashboard/src/components/order/OrderHeader.tsx
import { fmtUsd } from '../../lib/format';

interface Props {
  title: string;
  subtitle: string;
  quoteLine: string;
  positionLine: React.ReactNode;
}

export function OrderHeader({ title, subtitle, quoteLine, positionLine }: Props) {
  return (
    <div>
      <h1 className="text-[18px] font-bold tracking-tight text-hi">{title}</h1>
      <div className="text-mid text-[10px]"><span className="text-dim">{subtitle}</span></div>
      <div className="mt-2 flex justify-between flex-wrap gap-2 pb-2 border-b border-dashed border-border text-[12px]">
        <span className="text-mid">{quoteLine}</span>
        <span className="text-mid">{positionLine}</span>
      </div>
    </div>
  );
}

export { fmtUsd };
