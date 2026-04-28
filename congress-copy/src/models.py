"""Plain dataclasses used as the lingua franca between modules."""
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

AssetKind = Literal["stock", "etf", "option"]
Side = Literal["buy", "sell"]
OptionType = Literal["call", "put"]


@dataclass(frozen=True)
class OptionDetails:
    option_type: OptionType
    strike: Decimal
    expiry: datetime  # date-only semantics; time component ignored


@dataclass(frozen=True)
class Disclosure:
    trade_id: str           # CapitolTrades stable id, used as dedupe key
    politician_slug: str
    ticker: str
    side: Side
    asset_kind: AssetKind
    range_low: Decimal      # disclosed lower bound, USD
    range_high: Decimal     # disclosed upper bound, USD
    traded_at: datetime     # date the politician traded
    filed_at: datetime      # date filing was disclosed
    option: Optional[OptionDetails] = None  # only when asset_kind == "option"


@dataclass(frozen=True)
class OrderIntent:
    """What the trader wants Alpaca to do. Resolved sizing, ready to submit."""
    symbol: str             # stock ticker OR Alpaca option symbol (OCC format)
    side: Side
    notional_usd: Decimal   # for stocks: dollar amount; for options: ignored, qty used
    qty: Optional[int] = None  # for options: number of contracts; for stocks: None
    asset_kind: AssetKind = "stock"
    fallback_path: str = "direct"  # "direct" | "exact_option" | "similar_option" | "underlying"


@dataclass(frozen=True)
class FillResult:
    order_id: str
    status: Literal["filled", "pending", "rejected", "skipped"]
    filled_avg_price: Optional[Decimal] = None
    filled_qty: Optional[Decimal] = None
    reason: Optional[str] = None  # for rejected/skipped


@dataclass
class Position:
    symbol: str
    qty: Decimal
    avg_entry_price: Decimal
    current_price: Decimal
    market_value: Decimal
    unrealized_pl_pct: Decimal
