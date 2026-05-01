"""Read-only Alpaca data fetchers.

Single home for new data-fetching code shared across Claude Code skills
(tools/lookup.py, etc.) and any future read-only consumers (e.g. a Discord
bot). Strictly fetch-only — no order placement, no state mutation.

Auth: by default reads ALPACA_API_KEY / ALPACA_API_SECRET from the env. Pass
mode="aggressive" to use the aggressive paper account's keys instead. Market
data (stock quotes, options chains, Greeks) is identical across paper
accounts, so most lookup queries don't care about mode — but account / position
queries do.

Endpoints used:
  Trading API   https://paper-api.alpaca.markets/v2  (account, positions, contracts)
  Stock data    https://data.alpaca.markets/v2       (stock trades + bars)
  Options data  https://data.alpaca.markets/v1beta1  (option quotes/trades/snapshots)
"""

import os
from datetime import date, timedelta

import requests
from dotenv import load_dotenv

load_dotenv()

TRADING_API_URL = "https://paper-api.alpaca.markets/v2"
STOCK_DATA_URL = "https://data.alpaca.markets/v2"
OPT_DATA_URL = "https://data.alpaca.markets/v1beta1"

DEFAULT_TIMEOUT = 15


def _credentials(mode: str) -> tuple[str, str]:
    if mode == "aggressive":
        return (
            os.getenv("ALPACA_AGG_API_KEY", ""),
            os.getenv("ALPACA_AGG_API_SECRET", ""),
        )
    return (
        os.getenv("ALPACA_API_KEY", ""),
        os.getenv("ALPACA_API_SECRET", ""),
    )


def _headers(mode: str = "conservative") -> dict:
    key, secret = _credentials(mode)
    return {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        "accept": "application/json",
    }


def _get(url: str, mode: str, params: dict | None = None) -> dict:
    resp = requests.get(url, headers=_headers(mode), params=params, timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


# ── Stock data ──────────────────────────────────────────────────────────────

def get_stock_quote(symbol: str, mode: str = "conservative") -> dict:
    """Latest trade for a stock. Returns the inner trade dict (price `p`, etc.)."""
    data = _get(
        f"{STOCK_DATA_URL}/stocks/{symbol}/trades/latest",
        mode,
        params={"feed": "iex"},
    )
    return data["trade"]


def get_stock_bars(
    symbol: str,
    days: int = 90,
    timeframe: str = "1Day",
    mode: str = "conservative",
) -> list[dict]:
    """Historical OHLCV bars going back `days` calendar days from today."""
    end = date.today()
    start = end - timedelta(days=days)
    data = _get(
        f"{STOCK_DATA_URL}/stocks/{symbol}/bars",
        mode,
        params={
            "timeframe": timeframe,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "feed": "iex",
            "limit": 1000,
            "adjustment": "raw",
        },
    )
    return data.get("bars", [])


# ── Account / positions ────────────────────────────────────────────────────

def get_account(mode: str = "conservative") -> dict:
    return _get(f"{TRADING_API_URL}/account", mode)


def get_positions(mode: str = "conservative") -> list[dict]:
    return _get(f"{TRADING_API_URL}/positions", mode)


def get_position(symbol: str, mode: str = "conservative") -> dict | None:
    """Return the position for `symbol`, or None if not held."""
    resp = requests.get(
        f"{TRADING_API_URL}/positions/{symbol}",
        headers=_headers(mode),
        timeout=DEFAULT_TIMEOUT,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


# ── Options ─────────────────────────────────────────────────────────────────

def find_option_contracts(
    underlying: str,
    option_type: str,  # "put" or "call"
    exp_min_days: int,
    exp_max_days: int,
    strike_low: float | None = None,
    strike_high: float | None = None,
    mode: str = "conservative",
) -> list[dict]:
    """List active option contracts matching the filters."""
    today = date.today()
    params: dict = {
        "underlying_symbols": underlying,
        "type": option_type,
        "expiration_date_gte": (today + timedelta(days=exp_min_days)).isoformat(),
        "expiration_date_lte": (today + timedelta(days=exp_max_days)).isoformat(),
        "status": "active",
        "limit": 100,
    }
    if strike_low is not None:
        params["strike_price_gte"] = strike_low
    if strike_high is not None:
        params["strike_price_lte"] = strike_high
    data = _get(f"{TRADING_API_URL}/options/contracts", mode, params=params)
    return data.get("option_contracts", [])


def get_option_quote(contract_symbol: str, mode: str = "conservative") -> dict | None:
    """Latest bid/ask for an option contract.

    Returns {"bid", "ask", "bid_size", "ask_size"} or None if no quote.
    """
    data = _get(
        f"{OPT_DATA_URL}/options/quotes/latest",
        mode,
        params={"symbols": contract_symbol, "feed": "indicative"},
    )
    quotes = data.get("quotes", {})
    if contract_symbol not in quotes:
        return None
    q = quotes[contract_symbol]
    return {
        "bid": float(q.get("bp") or 0),
        "ask": float(q.get("ap") or 0),
        "bid_size": int(q.get("bs") or 0),
        "ask_size": int(q.get("as") or 0),
    }


def get_option_snapshot(contract_symbol: str, mode: str = "conservative") -> dict | None:
    """Snapshot for one contract: latest quote, last trade, Greeks, IV.

    Greeks dict keys: delta, gamma, theta, vega, rho.
    """
    data = _get(
        f"{OPT_DATA_URL}/options/snapshots/{contract_symbol}",
        mode,
        params={"feed": "indicative"},
    )
    snapshots = data.get("snapshots", {})
    return snapshots.get(contract_symbol)


def get_option_chain_snapshots(
    underlying: str,
    option_type: str | None = None,
    exp_min_days: int | None = None,
    exp_max_days: int | None = None,
    mode: str = "conservative",
) -> dict[str, dict]:
    """One-shot fetch of full chain snapshots for `underlying`.

    Each entry includes latestQuote, latestTrade, greeks, impliedVolatility.
    Returned dict is keyed by OCC option symbol.
    """
    params: dict = {"feed": "indicative", "limit": 1000}
    if option_type:
        params["type"] = option_type
    if exp_min_days is not None:
        params["expiration_date_gte"] = (date.today() + timedelta(days=exp_min_days)).isoformat()
    if exp_max_days is not None:
        params["expiration_date_lte"] = (date.today() + timedelta(days=exp_max_days)).isoformat()
    data = _get(f"{OPT_DATA_URL}/options/snapshots/{underlying}", mode, params=params)
    return data.get("snapshots", {})
