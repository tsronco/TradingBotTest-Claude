import type { OrderSide, AssetClass, ContractType } from './trade-types.js';

export interface CostBasisCcDraft {
  asset_class: AssetClass | 'stock' | 'option';
  side: OrderSide | string;
  contract_type: ContractType | null | undefined;
  symbol: string;
}

export function isCoveredCallOpen(d: CostBasisCcDraft): boolean {
  return d.asset_class === 'option' && d.contract_type === 'call' && d.side === 'STO';
}

/**
 * Resolve underlying cost basis from Alpaca positions for a covered-call open.
 * Returns null when the trade isn't a CC, when Alpaca has no position for the
 * underlying (404), or when the avg_entry_price is unparseable. Any other error
 * from the fetcher also resolves to null — capturing basis is best-effort and
 * must never block order submission.
 */
export async function resolveCostBasisForCc(
  draft: CostBasisCcDraft,
  fetchPosition: (underlying: string) => Promise<{ avg_entry_price?: string } | null>,
): Promise<number | null> {
  if (!isCoveredCallOpen(draft)) return null;
  if (!draft.symbol) return null;
  let pos: { avg_entry_price?: string } | null = null;
  try {
    pos = await fetchPosition(draft.symbol);
  } catch {
    return null;
  }
  if (!pos) return null;
  const n = Number(pos.avg_entry_price);
  return Number.isFinite(n) ? n : null;
}
