import type { AssetClass, OrderSide, OrderType, ContractType } from './trade-types.js';

export interface ExposureSpreadInput {
  width: number;
  net_credit: number;
  max_loss: number;
}

export interface ExposureInput {
  asset_class: AssetClass;
  side: OrderSide;
  qty: number;
  order_type: OrderType;
  limit_price: number | null;
  contract_type?: ContractType | null;
  strike?: number | null;
  ask?: number | null;
  bid?: number | null;
  spread?: ExposureSpreadInput;
}

export function computeExposure(input: ExposureInput): number {
  const { asset_class, side, qty, order_type, limit_price, ask, bid, strike, contract_type, spread } = input;

  if (asset_class === 'spread') {
    if (!spread) return 0;
    return spread.max_loss * 100 * qty;
  }

  if (asset_class === 'stock') {
    const px = order_type === 'market'
      ? side === 'buy' ? (ask ?? 0) : (bid ?? 0)
      : (limit_price ?? 0);
    return qty * px;
  }

  // option
  const px = order_type === 'market'
    ? (side === 'BTO' || side === 'BTC') ? (ask ?? 0) : (bid ?? 0)
    : (limit_price ?? 0);

  if (side === 'STO' && contract_type === 'put') {
    return (strike ?? 0) * qty * 100;
  }
  // D9 fix: STO call exposure is assignment notional (strike × qty × 100),
  // not premium received. Mirrors OptionOrderForm.tsx liveExposure which already
  // uses strike × 100 × qty for all STO opens. A covered call's shares-called-away
  // basis = strike × 100; a naked call's true risk is unbounded, but strike-notional
  // is the agreed conservative proxy (consistent with the STO-put branch above).
  if (side === 'STO' && contract_type === 'call') {
    return (strike ?? 0) * qty * 100;
  }
  return qty * px * 100;
}
