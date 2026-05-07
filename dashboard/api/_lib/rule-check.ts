import { kv } from './kv.js';
import { fetchEarningsDate } from './fundamentals-fetch.js';
import type { AssetClass, AccountId, RuleWarning } from './trade-types.js';

interface RuleCheckInput {
  asset_class: AssetClass;
  symbol: string;
  qty: number;
  account: AccountId;
}

export async function runStubRuleChecks(input: RuleCheckInput): Promise<RuleWarning[]> {
  const out: RuleWarning[] = [];

  // sizing_1x
  const sizingThreshold = input.asset_class === 'stock' ? 20 : 1;
  if (input.qty > sizingThreshold) {
    const multiple = input.asset_class === 'stock'
      ? `${(input.qty / 10).toFixed(1)}× normal`
      : `${input.qty}× normal`;
    out.push({
      rule: 'sizing_1x',
      severity: 'info',
      message: `order is ${multiple} size (>${sizingThreshold} ${input.asset_class === 'stock' ? 'shares' : 'contracts'}). reason should explain.`,
    });
  }

  // earnings_within_7d (stock and option both check the underlying)
  if (input.asset_class === 'stock' || input.asset_class === 'option') {
    const earnings = await fetchEarningsDate(input.symbol);
    if (earnings) {
      const days = Math.floor((new Date(earnings).getTime() - Date.now()) / 86400000);
      if (days >= 0 && days <= 7) {
        out.push({
          rule: 'earnings_within_7d',
          severity: 'warn',
          message: `earnings on ${earnings} (in ${days} day${days === 1 ? '' : 's'}). consider sizing down or waiting.`,
        });
      }
    }
  }

  // bot_wheel_overlap — checks all 3 paper accounts so any in-flight wheel
  // on the symbol is surfaced before the user opens an overlapping order.
  const cons = (await kv().get<Record<string, { stage?: number }>>('bot:state:conservative')) ?? {};
  const agg = (await kv().get<Record<string, { stage?: number }>>('bot:state:aggressive')) ?? {};
  const man = (await kv().get<Record<string, { stage?: number }>>('bot:state:manual')) ?? {};
  const consHas = cons[input.symbol]?.stage === 1 || cons[input.symbol]?.stage === 2;
  const aggHas = agg[input.symbol]?.stage === 1 || agg[input.symbol]?.stage === 2;
  const manHas = man[input.symbol]?.stage === 1 || man[input.symbol]?.stage === 2;
  if (consHas || aggHas || manHas) {
    const accounts = [consHas && 'conservative', aggHas && 'aggressive', manHas && 'manual']
      .filter(Boolean).join(' & ');
    out.push({
      rule: 'bot_wheel_overlap',
      severity: 'warn',
      message: `bot has an open wheel on ${input.symbol} in ${accounts}. new position will share BP.`,
    });
  }

  return out;
}
