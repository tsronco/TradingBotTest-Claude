export function fmtUsd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = opts.sign && n > 0 ? '+' : '';
  return `${sign}${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPct(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = opts.sign && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}
