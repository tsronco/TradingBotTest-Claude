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
  return qty * px * 100;
}
