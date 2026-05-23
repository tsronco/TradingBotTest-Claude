// dashboard/src/routes/StrategyPickContract.tsx
//
// Step 2 of the single-leg strategy flow: after the user picks (say)
// "Long Call" from /strategy/:symbol, we land here with ?leg=call&side=BTO
// and show them the options chain filtered to calls. Clicking a price
// routes to /order/new pre-configured with the right side (BTO/STO) and
// price.
//
// The forced side ensures we don't accidentally let a "Long Call" intent
// turn into an STO when the user clicks the bid by mistake.
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import OptionsChain from '../components/lookup/OptionsChain';
import type { ChainStrikeClick } from '../components/lookup/OptionsChain';
import { useDisplayName } from '../hooks/useDisplayName';
import { useAccount } from '../hooks/useAccount';
import { selectModeFromAccountMode, modeToAccount } from '../lib/account-utils';

const STRATEGY_DESCRIPTIONS: Record<string, { title: string; verb: string; direction: string }> = {
  'call-BTO':  { title: 'Long Call',         verb: 'Pick a call to BUY',  direction: 'Bullish' },
  'call-STO':  { title: 'Covered Call',      verb: 'Pick a call to SELL', direction: 'Bullish' },
  'put-BTO':   { title: 'Long Put',          verb: 'Pick a put to BUY',   direction: 'Bearish' },
  'put-STO':   { title: 'Cash-Secured Put',  verb: 'Pick a put to SELL',  direction: 'Bullish' },
};

export default function StrategyPickContract() {
  const { symbol = '' } = useParams();
  const sym = symbol.toUpperCase();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { handle } = useDisplayName();
  const [accountMode] = useAccount();

  const leg = (params.get('leg') ?? 'put') as 'put' | 'call';
  const side = (params.get('side') ?? 'STO') as 'BTO' | 'STO';
  const meta = STRATEGY_DESCRIPTIONS[`${leg}-${side}`] ?? STRATEGY_DESCRIPTIONS['put-STO'];

  function handleClick(info: ChainStrikeClick) {
    // The strategy intent fixes the side (BTO for Long Call/Put, STO for
    // Covered Call / CSP). Whatever cell the user tapped, route them to
    // the order ticket pre-filled with this strategy's side at the price
    // they clicked — they can adjust the limit before placing.
    const url = new URLSearchParams({
      contract: info.contract.symbol,
      action: 'open',
      side,
      account: modeToAccount(selectModeFromAccountMode(accountMode)),
    });
    if (Number.isFinite(info.price) && info.price > 0) {
      url.set('price', info.price.toFixed(2));
    }
    nav(`/order/new?${url.toString()}`);
  }

  return (
    <div className="p-3 md:p-6 max-w-[1200px]">
      {/* breadcrumb */}
      <div className="text-mid text-[12px] mb-2">
        <span className="text-cyan">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/strategy</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">pick --strategy={meta.title.toLowerCase().replace(/\s+/g, '_')} --symbol=<span className="text-amber">{sym}</span></span>
      </div>

      {/* header */}
      <div className="flex items-baseline justify-between flex-wrap gap-y-2 mb-2">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-hi text-[24px] md:text-[28px] font-bold leading-none">
            {meta.title}
          </h1>
          <span className="text-amber text-[16px] md:text-[18px] tnum">· {sym}</span>
          <span className={meta.direction === 'Bullish' ? 'text-hi text-[11px]' : 'text-red text-[11px]'}>
            {meta.direction}
          </span>
        </div>
        <Link
          to={`/strategy/${sym}`}
          className="text-mid hover:text-hi text-[12px] underline-offset-2 hover:underline"
        >
          ← back to strategies
        </Link>
      </div>

      <div className="border border-cyan/40 rounded-sm p-3 bg-cyan/5 text-cyan text-[12px] mb-4">
        {meta.verb} — tap any row to open the order ticket pre-filled with{' '}
        <span className="font-semibold">{side}</span>.
      </div>

      <OptionsChain
        symbol={sym}
        sideLock={leg === 'put' ? 'puts' : 'calls'}
        contextLabel={<span className="text-dim">// {meta.verb.toLowerCase()}</span>}
        onPriceClick={handleClick}
      />

      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ chain</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— click any price to continue</span>
      </div>
    </div>
  );
}
