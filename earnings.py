"""Earnings-date guard for the autonomous spread opener.

Conservative by design: if we cannot determine the next earnings date,
we treat the symbol as BLOCKED (better to skip a trade than sell premium
blind into a possible earnings print). Per-run in-memory cache; bounded
retry around the (rate-limited) yfinance call.
"""
import datetime as dt
import time
from typing import Optional

_CACHE: dict[str, Optional[dt.datetime]] = {}
# Most recent PAST earnings date, from the same yfinance call as the next one.
# "Days since the last print" is what separates structurally low implied vol
# from vol that is simply deflated because the event already happened.
_LAST_CACHE: dict[str, Optional[dt.datetime]] = {}
_MAX_ATTEMPTS = 3
_BACKOFFS = (1, 3)  # seconds; indexed by attempt -> needs len == _MAX_ATTEMPTS-1


def _next_earnings_dt(symbol: str) -> Optional[dt.datetime]:
    import yfinance as yf
    for attempt in range(_MAX_ATTEMPTS):
        try:
            edf = yf.Ticker(symbol).get_earnings_dates(limit=8)
            if edf is None or len(edf) == 0:
                return None
            today = dt.datetime.now(dt.timezone.utc).date()
            # R16 (2026-06-16): include same-DAY earnings. yfinance often dates an
            # entry at midnight UTC, so a `>= now` (timestamp) filter would DROP an
            # earnings happening later today once it's past midnight — letting the
            # opener sell premium straight into a same-session print. Filter on the
            # DATE so today's earnings is still caught.
            stamps = [ix.to_pydatetime().astimezone(dt.timezone.utc) for ix in edf.index]
            future = [t for t in stamps if t.date() >= today]
            past = [t for t in stamps if t.date() < today]
            # Same response, so recording the last print costs no extra call.
            _LAST_CACHE[symbol] = max(past) if past else None
            return min(future) if future else None
        except Exception as e:
            if attempt + 1 < _MAX_ATTEMPTS:
                print(f"[earnings] {symbol} attempt {attempt+1}/{_MAX_ATTEMPTS} failed: {type(e).__name__}: {e}; retrying in {_BACKOFFS[attempt]}s", flush=True)
                time.sleep(_BACKOFFS[attempt])
                continue
            print(f"[earnings] {symbol} all {_MAX_ATTEMPTS} attempts failed: {type(e).__name__}: {e}; treating as BLOCKED", flush=True)
            return None


def next_earnings_within(symbol: str, days: int) -> bool:
    """True = earnings within `days` (or unknown) -> caller should SKIP."""
    if symbol not in _CACHE:
        _CACHE[symbol] = _next_earnings_dt(symbol)
    nxt = _CACHE[symbol]
    if nxt is None:
        return True  # unknown -> conservative block
    # Whole-DAY difference (R16), robust to yfinance's midnight dating: a same-
    # day earnings (days_until == 0) blocks, through `days` out. The old seconds-
    # based `0 <= delta` let a same-day midnight-dated earnings — whose delta is
    # NEGATIVE by the afternoon — slip through as "not within" and open into it.
    days_until = (nxt.astimezone(dt.timezone.utc).date()
                  - dt.datetime.now(dt.timezone.utc).date()).days
    return 0 <= days_until <= days


def earnings_context(symbol: str) -> dict:
    """Earnings timing around `symbol`, for reasoning about implied vol.

    Best-effort and non-blocking — unlike `next_earnings_within`, which fails
    closed because it gates real orders, this is context for a prompt. An
    unknown date reports None and the model is told to treat it as unknown.
    """
    if symbol not in _CACHE:
        _CACHE[symbol] = _next_earnings_dt(symbol)
    today = dt.datetime.now(dt.timezone.utc).date()
    nxt = _CACHE.get(symbol)
    last = _LAST_CACHE.get(symbol)
    return {
        "days_to_next_earnings": (nxt.astimezone(dt.timezone.utc).date() - today).days
        if nxt else None,
        "days_since_last_earnings": (today - last.astimezone(dt.timezone.utc).date()).days
        if last else None,
        "next_earnings_date": nxt.date().isoformat() if nxt else None,
    }
