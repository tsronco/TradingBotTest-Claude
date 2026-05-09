import { Link } from 'react-router-dom';

interface Props {
  direction: 'up' | 'down';
  tradeId: string;
  inherited?: boolean;
}

export default function AssignmentLink({ direction, tradeId, inherited }: Props) {
  const arrow = direction === 'up' ? '↑' : '↓';
  const label = direction === 'up' ? 'Assigned from' : 'Assignment spawned';

  return (
    <div className="border border-cyan/40 bg-cyan/5 rounded-sm px-3 py-2 text-[11px] flex items-center gap-2 flex-wrap">
      <span className="text-cyan font-semibold">{arrow} {label}</span>
      <Link to={`/trade/${tradeId}`} className="text-cyan hover:underline font-mono">
        {tradeId}
      </Link>
      {direction === 'up' && inherited && (
        <span className="text-dim text-[10px]">(grades inherited from parent)</span>
      )}
    </div>
  );
}
