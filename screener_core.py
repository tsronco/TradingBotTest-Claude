"""screener_core — pure, dependency-free scoring + universe builder.

Extracted from wheel_screener.py so the auto-spread engine (Phase 4) can
reuse the same score formula without importing the network-heavy screener.

``score_candidate(...)`` here is the canonical self-contained injectable
scorer (used by the Phase-4 auto-spread engine); pass ``api_get`` plus
dte/discount kwargs.

Public API:
    score_from_quote(strike, bid, ask, free_bp)  -> dict   (pure, no I/O)
    score_candidate(symbol, free_bp, *, api_get, target_dte_min,
                    target_dte_max, put_strike_discount)    -> dict | None
    build_universe(cfg_universe, already_wheeled)           -> list[str]
    round_strike(target, reference_price)                   -> float
    DEFAULT_CONSERVATIVE_UNIVERSE                           : list[str]
    MIN_STOCK_PRICE                                         : float

Score formula: see ``score_from_quote`` implementation — premium yield,
minus spread-width penalty, plus a budget-fit bonus.

Returned dict keys from score_candidate (legacy shape — must not change):
    symbol, price, strike, expiry, option_symbol, bid, ask, mid,
    premium_yield, spread_pct, collateral, budget_fit, score
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

DEFAULT_CONSERVATIVE_UNIVERSE: list[str] = sorted({
    # ── Tech / semis (large-cap, liquid options) ──
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AMD", "INTC", "ORCL",
    "CRM", "ADBE", "IBM", "CSCO", "MU", "AVGO", "QCOM", "TXN", "AMAT",
    "KLAC", "LRCX", "PYPL", "HPQ", "DELL", "MRVL", "NXPI", "MCHP", "ADI",
    "FTNT", "PANW", "CRWD", "SHOP", "ABNB", "NFLX",
    # ── Banks / finance ──
    "JPM", "WFC", "C", "GS", "AXP", "V", "MA", "BAC", "MS", "BLK", "SCHW",
    "USB", "PNC", "TFC",
    # ── Energy / materials ──
    "CVX", "COP", "XOM", "KMI", "OXY", "SLB", "HAL", "NEM", "DOW", "LYB",
    # ── Consumer / retail ──
    "PEP", "WMT", "COST", "NKE", "MCD", "SBUX", "HD", "DIS", "TGT", "LOW",
    "KO", "PG", "MDLZ",
    # ── Telecom ──
    "T", "VZ",
    # ── Healthcare (mature large-cap; no biotech) ──
    "JNJ", "UNH", "MRK", "ABBV", "PFE", "CVS", "MDT", "BMY", "GILD",
    "AMGN", "ABT",
    # ── Auto / industrial / defense ──
    "F", "GM", "CAT", "DE", "HON", "GE", "RTX", "LMT",
    # ── Mobility / misc large-cap ──
    "UBER", "LYFT", "PLTR", "PINS",
    # ── Travel / airlines ──
    "DAL", "LUV",
    # ── Additional energy ──
    "BP", "PBR", "RIG",
    # ── Additional consumer / retail ──
    "CL", "ORLY", "WBA",
    # ── Broad-market ETFs (no single-name earnings risk; lower IV ↔ thinner
    # premiums, but happy-to-own + deep liquidity for the index trackers)
    "SPY", "QQQ", "IWM",
    # ── ≤$25 tier (sm500-eligible: liquid options, would own at assignment) ──
    "SOFI", "NIO", "CCL", "AAL", "NOK", "SNAP", "WBD", "PARA", "NCLH",
    "HOOD", "RIVN", "CLF", "VALE", "KGC", "GOLD", "AES", "KEY", "RF",
    "HBAN", "FITB", "ALLY", "SYF", "MOS", "SIRI", "KSS", "M", "HPE",
    "GRAB",
})


# ── SM-mode curated universe ─────────────────────────────────────────────
# Hand-picked for the hardened SM auto-spread engine (2026-05-19). Criteria:
#   - liquid options (weeklies or active monthlies)
#   - tight bid/ask spreads on near-the-money puts
#   - IV high enough that ~10% OTM puts at 14-28 DTE can clear the
#     min_credit_to_width_pct floor (0.33 Balanced / 0.40 Conservative)
#   - quality enough that an assignment wouldn't be a disaster (though
#     SM modes never accept assignment — spread is defined-risk)
#
# Deliberately EXCLUDES the ≤$25 junk tier the old sm500 filter selected
# blindly — NCLH, HPQ, KSS, NIO, NOK, HOOD, GRAB, CLF, AES, NEM, GOLD,
# FITB, ALLY, SYF, MOS, SIRI — those names were the source of the
# −$280 / −8% bleed over 2026-05-18 to 2026-05-19.
#
# Expanded 2026-05-21 from 12 → 52 names. The hardening guardrails added
# 2026-05-19 (33% credit-to-width ratio for sm1000/sm2000, 40% for sm500,
# 2× credit stop, trend filter, underlying tripwire, raised sm500 risk
# cap to 20%) are expected to catch any lower-quality behavior even on
# sub-$25 adds (AAL/WBD/PARA/SNAP/WBA/etc. are deliberately re-included
# vs. the original post-bleed conservative reset). Wheelability floor
# also dropped 85 → 80 on sm1000/sm2000 to give the expanded pool a
# real chance to surface a top candidate.
SM_CURATED_UNIVERSE: list[str] = sorted({
    # Mega/large-cap tech (sm2000 stretch + adoption)
    "AAPL", "MSFT", "GOOGL", "AMZN", "AVGO", "QCOM",
    # Semis (Balanced posture credit floor target)
    "AMD", "NVDA", "MU", "INTC", "MRVL",
    # Financials
    "BAC", "JPM", "WFC", "HBAN", "KEY",
    # Energy
    "XOM", "CVX", "BP", "OXY", "SLB", "KMI", "PBR", "RIG",
    # Healthcare / pharma
    "PFE", "ABBV", "CVS", "WBA",
    # Consumer / retail
    "KO", "WMT", "CL", "ORLY",
    # Telecom / media / streaming
    "T", "VZ", "DIS", "NFLX", "PARA", "WBD",
    # Mobility / software
    "PLTR", "SOFI", "UBER", "LYFT", "PINS", "SNAP",
    # Auto / airlines / industrials
    "F", "GM", "DAL", "LUV", "AAL", "CCL",
    # Materials
    "VALE", "KGC",
    # Broad-market ETFs (no earnings risk; structurally fit manual+adoption
    # tier — $5 strikes at $200-750 prices put $5-wide spread max loss at
    # $400-500, which fits manual's $1k cap but not the SM caps; SM modes
    # will gate them out naturally on the budget check)
    "SPY", "QQQ", "IWM",
})


# ── Pure scoring math (no I/O) ────────────────────────────────────────────


def score_from_quote(
    strike: float,
    bid: float,
    ask: float,
    free_bp: float,
) -> dict:
    """Pure score computation — no network I/O, directly unit-testable.

    Returns a dict with premium_yield, spread_pct, collateral, budget_fit,
    and score (using the exact formula from wheel_screener.py).
    """
    mid = (bid + ask) / 2
    premium_yield = bid / strike
    spread_pct    = (ask - bid) / mid if mid > 0 else 0.0
    collateral    = strike * 100
    budget_fit    = collateral <= free_bp  # bool
    budget_num    = 1.0 if budget_fit else 0.0
    score         = premium_yield * 100 - spread_pct * 50 + budget_num * 5

    return {
        "premium_yield": premium_yield,
        "spread_pct":    spread_pct,
        "collateral":    collateral,
        "budget_fit":    budget_fit,
        "score":         score,
        "mid":           mid,
        "bid":           bid,
        "ask":           ask,
    }


# ── Network helpers (private — injected or overridden in tests) ───────────


def _get_latest_price(symbol: str, headers: dict) -> Optional[float]:
    """Fetch the latest stock price via Alpaca data API. Returns None on error."""
    import requests
    DATA_URL = "https://data.alpaca.markets/v2"
    try:
        resp = requests.get(
            f"{DATA_URL}/stocks/{symbol}/trades/latest",
            headers=headers,
            params={"feed": "iex"},
            timeout=10,
        )
        resp.raise_for_status()
        return float(resp.json()["trade"]["p"])
    except Exception:
        return None


def _get_option_quote(option_symbol: str, headers: dict) -> Optional[dict]:
    """Fetch the latest option quote. Returns {'bid': float, 'ask': float} or None."""
    import requests
    OPTIONS_DATA_URL = "https://data.alpaca.markets/v1beta1"
    try:
        resp = requests.get(
            f"{OPTIONS_DATA_URL}/options/quotes/latest",
            headers=headers,
            params={"symbols": option_symbol, "feed": "indicative"},
            timeout=10,
        )
        resp.raise_for_status()
        q = resp.json().get("quotes", {}).get(option_symbol)
        if q:
            bid = float(q.get("bp") or 0)
            ask = float(q.get("ap") or 0)
            if bid > 0 and ask > 0:
                return {"bid": bid, "ask": ask}
    except Exception:
        pass
    return None


def is_above_sma20(
    symbol: str,
    current_price: float,
    fetch_closes,
) -> bool:
    """Return True iff current_price >= mean of last 20 daily closes.

    Used as the trend gate on the SM auto-spread engine: we only open
    a put credit spread when the underlying is at or above its 20-day
    SMA (i.e., not in a short-term downtrend).

    Fail-closed posture: any failure to obtain 20 valid closes returns
    False. Selling puts on a symbol whose trend we cannot verify is
    the exact failure mode this gate exists to prevent.

    Parameters
    ----------
    symbol         For logging context only — does not affect the math.
    current_price  Latest stock price (caller already has this from
                   score_candidate's `r["price"]`; passing it in avoids
                   a redundant API call).
    fetch_closes   Callable(symbol) -> list[float] | None. The 20 most
                   recent daily closes (oldest first or newest first —
                   order does not affect the mean). Injected so tests
                   stay pure-Python.
    """
    try:
        closes = fetch_closes(symbol)
    except Exception:
        return False
    if not closes or len(closes) < 20:
        return False
    sma20 = sum(closes[-20:]) / 20.0
    return current_price >= sma20


# ── Round-strike helper (shared) ─────────────────────────────────────────


def round_strike(target: float, reference_price: float) -> float:
    """$1 increment under $25, $5 at/above — single-sourced for both screeners."""
    inc = 1.0 if reference_price < 25 else 5.0
    return round(target / inc) * inc


# ── score_candidate (fetches via injected api_get) ─────────────────────────

MIN_STOCK_PRICE = 5.0


def score_candidate(
    symbol: str,
    free_bp: float,
    *,
    api_get,
    target_dte_min: int,
    target_dte_max: int,
    put_strike_discount: float,
    headers: Optional[dict] = None,
) -> Optional[dict]:
    """Score a single ticker.

    Parameters
    ----------
    symbol              Ticker to score.
    free_bp             Options buying power available.
    api_get             Callable(path, params=None) -> dict — injected so tests
                        can replace it without network access.
    target_dte_min/max  DTE window for contract search.
    put_strike_discount Fractional OTM discount (e.g. 0.10 for 10% OTM).
    headers             Alpaca auth headers (needed for price + quote calls
                        when the real network helpers are used; may be None in
                        tests that patch _get_latest_price/_get_option_quote).

    Returns the legacy dict on success (keys: symbol, price, strike, expiry,
    option_symbol, bid, ask, mid, premium_yield, spread_pct, collateral,
    budget_fit, score), or None if any required data is unavailable.
    """
    price = _get_latest_price(symbol, headers or {})
    if price is None or price < MIN_STOCK_PRICE:
        return None

    target_strike = round_strike(price * (1 - put_strike_discount), price)

    today = date.today()
    exp_min = (today + timedelta(days=target_dte_min)).isoformat()
    exp_max = (today + timedelta(days=target_dte_max)).isoformat()
    data = api_get("/options/contracts", params={
        "underlying_symbols":  symbol,
        "type":                "put",
        "expiration_date_gte": exp_min,
        "expiration_date_lte": exp_max,
        "strike_price_gte":    target_strike - 15,
        "strike_price_lte":    target_strike + 15,
        "limit":               50,
    })
    contracts = data.get("option_contracts", [])
    if not contracts:
        return None

    target_exp = today + timedelta(days=(target_dte_min + target_dte_max) // 2)

    def closeness(c):
        strike_diff = abs(float(c["strike_price"]) - target_strike)
        exp_diff    = abs((date.fromisoformat(c["expiration_date"]) - target_exp).days)
        return strike_diff * 2 + exp_diff

    contract = min(contracts, key=closeness)

    quote = _get_option_quote(contract["symbol"], headers or {})
    if quote is None:
        return None

    bid = quote["bid"]
    ask = quote["ask"]
    mid = (bid + ask) / 2
    if mid <= 0:
        return None

    strike = float(contract["strike_price"])
    scored = score_from_quote(strike=strike, bid=bid, ask=ask, free_bp=free_bp)

    return {
        "symbol":        symbol,
        "price":         price,
        "strike":        strike,
        "expiry":        contract["expiration_date"],
        "option_symbol": contract["symbol"],
        "bid":           bid,
        "ask":           ask,
        "mid":           mid,
        "premium_yield": scored["premium_yield"],
        "spread_pct":    scored["spread_pct"],
        "collateral":    scored["collateral"],
        "budget_fit":    scored["budget_fit"],
        "score":         scored["score"],
    }


# ── Universe builder ─────────────────────────────────────────────────────


def build_universe(cfg_universe, already_wheeled) -> list[str]:
    """Build the screener universe for a mode.

    Parameters
    ----------
    cfg_universe    Mode's `screener_universe` config value — list[str] or None.
                    When None, falls back to DEFAULT_CONSERVATIVE_UNIVERSE.
    already_wheeled Iterable of symbols already on the wheel (excluded).

    Returns a sorted, deduplicated list.
    """
    base = cfg_universe if cfg_universe is not None else DEFAULT_CONSERVATIVE_UNIVERSE
    return sorted(set(base) - set(already_wheeled))
