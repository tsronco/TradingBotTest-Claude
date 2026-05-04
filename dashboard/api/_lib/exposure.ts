import type { AssetClass, OrderSide, OrderType, ContractType } from './trade-types.js';

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
}

export function computeExposure(input: ExposureInput): number {
  const { asset_class, side, qty, order_type, limit_price, ask, bid, strike, contract_type } = input;

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
  return qty * px * 100;
}
