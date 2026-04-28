"""Cascading fallback: exact contract → similar contract → underlying → skip."""
from decimal import Decimal
from typing import Optional

import config
from src.alpaca_client import AlpacaClient
from src.models import Disclosure, OrderIntent


def resolve_option(
    disclosure: Disclosure,
    notional: Decimal,
    alpaca: AlpacaClient,
) -> Optional[OrderIntent]:
    """Return the best-effort OrderIntent for a disclosed option trade, or None."""
    if disclosure.option is None:
        raise ValueError("resolve_option called with non-option disclosure")

    opt = disclosure.option

    symbol = alpaca.find_option_contract(
        underlying=disclosure.ticker,
        option_type=opt.option_type,
        target_strike=opt.strike,
        target_expiry=opt.expiry,
        min_days_to_expiry=config.OPTIONS_MIN_DAYS_TO_EXPIRY,
        max_strike_deviation_pct=config.OPTIONS_MAX_STRIKE_DEVIATION_PCT,
    )

    if symbol:
        contracts = max(1, int(notional / Decimal("5000")))
        return OrderIntent(
            symbol=symbol,
            side=disclosure.side,
            notional_usd=Decimal(0),
            qty=contracts,
            asset_kind="option",
            fallback_path="exact_option",
        )

    if not config.OPTIONS_UNDERLYING_FALLBACK:
        return None

    # Long call or short put → bullish (buy underlying)
    # Long put or short call → bearish (sell underlying)
    bullish = (opt.option_type == "call" and disclosure.side == "buy") or (
        opt.option_type == "put" and disclosure.side == "sell"
    )
    underlying_side = "buy" if bullish else "sell"

    return OrderIntent(
        symbol=disclosure.ticker,
        side=underlying_side,
        notional_usd=notional,
        asset_kind="stock",
        fallback_path="underlying",
    )
