import type { RuleWarning } from '../../lib/trade-types';

interface Props {
  violations: RuleWarning[];
  showOkWhenEmpty?: boolean;
}

function severityColor(s: 'block' | 'warn' | 'info'): string {
  if (s === 'block') return 'text-red';
  if (s === 'warn') return 'text-amber';
  return 'text-mid';
}

export default function RuleViolationsBanner({ violations, showOkWhenEmpty = false }: Props) {
  if (violations.length === 0) {
    if (!showOkWhenEmpty) return null;
    return <div className="text-hi text-[10px]">▸ ok — no warnings</div>;
  }
  return (
    <ul className="space-y-0.5">
      {violations.map((v, i) => (
        <li key={`${v.rule}-${i}`} className={`text-[10px] ${severityColor(v.severity)}`}>
          <span className="uppercase tracking-wider mr-2 font-semibold">{v.severity}</span>
          <span className="text-fg/90">{v.rule}:</span>{' '}
          <span>{v.message}</span>
        </li>
      ))}
    </ul>
  );
}
