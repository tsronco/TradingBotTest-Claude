// Centralized greek/IV definitions so OptionsChain headers and OptionOrderForm
// inline displays stay in sync. Hover anywhere shows the native browser tooltip
// with the plain-English explanation.

export const GREEK_DEFS = {
  delta: {
    symbol: 'Δ',
    name: 'delta',
    tooltip:
      'Delta — how much the option price moves per $1 change in the underlying. Puts are negative (–1 to 0). Roughly approximates the probability of expiring in-the-money.',
  },
  gamma: {
    symbol: 'Γ',
    name: 'gamma',
    tooltip:
      'Gamma — how fast delta changes per $1 move in the underlying. Highest for at-the-money options. Tells you how quickly your directional exposure shifts.',
  },
  theta: {
    symbol: 'Θ',
    name: 'theta',
    tooltip:
      'Theta — daily time decay. How much value the option loses per day, all else equal. Negative for buyers, positive for sellers (you collect theta when selling premium).',
  },
  vega: {
    symbol: 'ν',
    name: 'vega',
    tooltip:
      'Vega — sensitivity to a 1% change in implied volatility. Higher vega = option price swings more on IV changes. Long options are vega-positive, short options vega-negative.',
  },
  iv: {
    symbol: 'IV',
    name: 'implied vol',
    tooltip:
      'Implied volatility — the market’s forecast of how much the underlying will move (annualized). Higher IV = richer premiums. Often spikes around earnings.',
  },
  oi: {
    symbol: 'OI',
    name: 'open interest',
    tooltip:
      'Open interest — total contracts of this strike/expiration currently held open across the market. Liquidity proxy: high OI = tight spreads and easy fills.',
  },
} as const;

export type GreekKey = keyof typeof GREEK_DEFS;

/** Stacked label for table headers — symbol on top, name below in tiny dim text. */
export function GreekHeader({ k, align = 'right' }: { k: GreekKey; align?: 'left' | 'right' }) {
  const d = GREEK_DEFS[k];
  return (
    <span
      title={d.tooltip}
      className={`cursor-help inline-flex flex-col leading-none ${align === 'right' ? 'items-end' : 'items-start'}`}
    >
      <span>{d.symbol}</span>
      <span className="text-[7px] tracking-[0.05em] text-dim/70 mt-0.5 normal-case">{d.name}</span>
    </span>
  );
}

/** Inline tooltip wrapper — for places where the symbol+value live together
 *  (e.g. OptionOrderForm). Renders children unchanged, just adds the title. */
export function GreekTip({ k, children }: { k: GreekKey; children: React.ReactNode }) {
  return (
    <span title={GREEK_DEFS[k].tooltip} className="cursor-help">
      {children}
    </span>
  );
}
