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
_MAX_ATTEMPTS = 3
_BACKOFFS = (1, 3)


def _next_earnings_dt(symbol: str) -> Optional[dt.datetime]:
    import yfinance as yf
    for attempt in range(_MAX_ATTEMPTS):
        try:
            edf = yf.Ticker(symbol).get_earnings_dates(limit=8)
            if edf is None or len(edf) == 0:
                return None
            now = dt.datetime.now(dt.timezone.utc)
            future = [ix.to_pydatetime() for ix in edf.index
                      if ix.to_pydatetime().astimezone(dt.timezone.utc) >= now]
            return min(future).astimezone(dt.timezone.utc) if future else None
        except Exception:
            if attempt + 1 < _MAX_ATTEMPTS:
                time.sleep(_BACKOFFS[attempt])
                continue
            return None
    return None


def next_earnings_within(symbol: str, days: int) -> bool:
    """True = earnings within `days` (or unknown) -> caller should SKIP."""
    if symbol not in _CACHE:
        _CACHE[symbol] = _next_earnings_dt(symbol)
    nxt = _CACHE[symbol]
    if nxt is None:
        return True  # unknown -> conservative block
    delta = (nxt - dt.datetime.now(dt.timezone.utc)).total_seconds()
    return 0 <= delta <= days * 86400
