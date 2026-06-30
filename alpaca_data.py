"""Read-only Alpaca data fetchers.

Single home for new data-fetching code shared across Claude Code skills
(tools/lookup.py, etc.) and any future read-only consumers (e.g. a Discord
bot). Strictly fetch-only — no order placement, no state mutation.

Auth: by default reads ALPACA_MANUAL_API_KEY / ALPACA_MANUAL_API_SECRET from
the env (the manual paper account). Pass mode="live" to use the real-money
live account's keys (and the live trading endpoint). Market data (stock quotes,
options chains, Greeks) is identical across accounts, so most lookup queries
don't care about mode — but account / position queries do.

(The conservative/aggressive and sm* accounts were retired 2026-06-29.)

Endpoints used:
  Trading API   https://paper-api.alpaca.markets/v2  (manual: account/positions)
                https://api.alpaca.markets/v2        (live: account/positions)
  Stock data    https://data.alpaca.markets/v2       (stock trades + bars)
  Options data  https://data.alpaca.markets/v1beta1  (option quotes/trades/snapshots)
"""

import os
import sys
import time
from datetime import date, timedelta

import requests
from dotenv import load_dotenv

load_dotenv()

TRADING_API_URL = "https://paper-api.alpaca.markets/v2"
LIVE_TRADING_API_URL = "https://api.alpaca.markets/v2"
STOCK_DATA_URL = "https://data.alpaca.markets/v2"
OPT_DATA_URL = "https://data.alpaca.markets/v1beta1"

DEFAULT_TIMEOUT = 15


def _trading_base(mode: str) -> str:
    """Trading API base URL for the mode. Live hits the real-money endpoint;
    manual (and anything else) hits the paper endpoint."""
    return LIVE_TRADING_API_URL if mode == "live" else TRADING_API_URL

# Retry policy — mirrors wheel_strategy._alpaca_request and
# notifications/discord._post. Transient network failures shouldn't crash
# a lookup or a script. See wheel_strategy.py for the full rationale.
_RETRY_STATUS = {429, 500, 502, 503, 504}
_RETRY_BACKOFFS = (2, 8)
_MAX_ATTEMPTS = 3


def _credentials(mode: str) -> tuple[str, str]:
    if mode == "live":
        return (
            os.getenv("ALPACA_LIVE_API_KEY", ""),
            os.getenv("ALPACA_LIVE_API_SECRET", ""),
        )
    # Default: manual paper account.
    return (
        os.getenv("ALPACA_MANUAL_API_KEY", ""),
        os.getenv("ALPACA_MANUAL_API_SECRET", ""),
    )


def _headers(mode: str = "manual") -> dict:
    key, secret = _credentials(mode)
    return {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        "accept": "application/json",
    }


def _request_with_retry(method: str, url: str, **kwargs) -> requests.Response:
    """Make a request with bounded retry. Returns Response without raising
    on any status code — caller decides what to do with the result. Used
    by `_get` (which raises) and `get_position` (which treats 404 as
    not-held)."""
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = requests.request(method, url, **kwargs)
            if (resp.status_code in _RETRY_STATUS
                    and attempt + 1 < _MAX_ATTEMPTS):
                wait = _RETRY_BACKOFFS[attempt]
                print(f"[alpaca_data] {method} {resp.status_code} (attempt "
                      f"{attempt+1}/{_MAX_ATTEMPTS}); retrying in {wait}s",
                      file=sys.stderr)
                time.sleep(wait)
                continue
            return resp
        except (requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as e:
            if attempt + 1 < _MAX_ATTEMPTS:
                wait = _RETRY_BACKOFFS[attempt]
                print(f"[alpaca_data] {method} {type(e).__name__} (attempt "
                      f"{attempt+1}/{_MAX_ATTEMPTS}); retrying in {wait}s",
                      file=sys.stderr)
                time.sleep(wait)
                continue
            raise


def _get(url: str, mode: str, params: dict | None = None) -> dict:
    """GET an Alpaca endpoint with bounded retry. Raises HTTPError on 4xx/5xx
    after retries are exhausted (existing contract — callers expect raise)."""
    resp = _request_with_retry("GET", url, headers=_headers(mode),
                                params=params, timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


# ── Stock data ──────────────────────────────────────────────────────────────

def get_stock_quote(symbol: str, mode: str = "manual") -> dict:
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
    mode: str = "manual",
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

def get_account(mode: str = "manual") -> dict:
    return _get(f"{_trading_base(mode)}/account", mode)


def get_positions(mode: str = "manual") -> list[dict]:
    return _get(f"{_trading_base(mode)}/positions", mode)


def get_position(symbol: str, mode: str = "manual") -> dict | None:
    """Return the position for `symbol`, or None if not held."""
    resp = _request_with_retry(
        "GET",
        f"{_trading_base(mode)}/positions/{symbol}",
        headers=_headers(mode),
        timeout=DEFAULT_TIMEOUT,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def get_portfolio_history(
    period: str = "1M",
    timeframe: str = "1D",
    mode: str = "manual",
) -> dict:
    """Equity history for the account.

    period: 1D, 1W, 1M, 3M, 1A, or "all" (Alpaca: omitted → max).
    timeframe: 1Min, 5Min, 15Min, 1H, 1D.
    Returns {timestamp: [...], equity: [...], profit_loss: [...], profit_loss_pct: [...]}.
    """
    params = {"period": period, "timeframe": timeframe}
    return _get(f"{_trading_base(mode)}/account/portfolio/history", mode, params=params)


def get_orders(
    status: str = "open",
    limit: int = 100,
    mode: str = "manual",
) -> list[dict]:
    """List orders. status: open | closed | all."""
    return _get(
        f"{_trading_base(mode)}/orders",
        mode,
        params={"status": status, "limit": limit, "direction": "desc"},
    )


# ── Options ─────────────────────────────────────────────────────────────────

def find_option_contracts(
    underlying: str,
    option_type: str,  # "put" or "call"
    exp_min_days: int,
    exp_max_days: int,
    strike_low: float | None = None,
    strike_high: float | None = None,
    mode: str = "manual",
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
    data = _get(f"{_trading_base(mode)}/options/contracts", mode, params=params)
    return data.get("option_contracts", [])


def get_option_quote(contract_symbol: str, mode: str = "manual") -> dict | None:
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


def get_option_snapshot(contract_symbol: str, mode: str = "manual") -> dict | None:
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
    mode: str = "manual",
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
