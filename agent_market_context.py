"""Trailing price context for the autonomous agent's decision prompt.

Why this exists
---------------
The agent used to see only *today*: last price, today's percent change, the
day's high/low and volume. With no history in front of it, any statement about
trend was unfalsifiable — and on 2026-08-17 it wrote "a steady grind higher"
into a CVS thesis while CVS had in fact been drifting sideways-to-down. That is
not a reasoning failure so much as a missing-input failure: there was nothing
for the claim to be checked against, by the model or by us.

These functions turn daily bars into the handful of numbers that make a trend
claim checkable: returns over 1 week / 1 month / 3 months, where price sits
relative to its 20-day average, and how far it is off its 52-week extremes.

Everything here is pure — bars in, numbers out — so the arithmetic is testable
without touching Alpaca. Fetching lives in agent_trader.
"""
from __future__ import annotations

# Trading days, not calendar days: bars only exist for sessions.
LOOKBACK_1W = 5
LOOKBACK_1M = 21
LOOKBACK_3M = 63
SMA_WINDOW = 20
# A 52-week window is ~252 sessions; anything shorter is labelled by what it
# actually covers rather than pretending to be a year.
WINDOW_52W = 252


def _closes(bars: list[dict]) -> list[float]:
    """Chronological closes, skipping malformed bars rather than failing."""
    out: list[float] = []
    for b in bars or []:
        c = (b or {}).get("c")
        if isinstance(c, (int, float)) and c > 0:
            out.append(float(c))
    return out


def _pct_change(now: float, then: float) -> float | None:
    if not then:
        return None
    return round((now - then) / then * 100, 2)


def _return_over(closes: list[float], sessions: int) -> float | None:
    """Percent change from `sessions` bars ago to the latest close.

    Returns None rather than a wrong number when the history is too short —
    a 3-month return computed from three weeks of data would be worse than
    no answer, because it reads as authoritative.
    """
    if len(closes) < sessions + 1:
        return None
    return _pct_change(closes[-1], closes[-(sessions + 1)])


def sma(closes: list[float], window: int = SMA_WINDOW) -> float | None:
    if len(closes) < window:
        return None
    return round(sum(closes[-window:]) / window, 4)


def trailing_stats(bars: list[dict]) -> dict:
    """Trend context for one symbol.

    Every value is either a real number or None. None means "not enough
    history" and the prompt tells the model to treat it as unknown rather than
    as zero or as confirmation.
    """
    closes = _closes(bars)
    if not closes:
        return {"available": False, "note": "no daily bars available"}

    last = closes[-1]
    avg20 = sma(closes)
    window = closes[-WINDOW_52W:]
    hi = max(window)
    lo = min(window)

    return {
        "available": True,
        "sessions_of_history": len(closes),
        "last_close": round(last, 4),
        "return_1w_pct": _return_over(closes, LOOKBACK_1W),
        "return_1m_pct": _return_over(closes, LOOKBACK_1M),
        "return_3m_pct": _return_over(closes, LOOKBACK_3M),
        "sma20": avg20,
        # Positive = trading above its 20-day average.
        "pct_vs_sma20": _pct_change(last, avg20) if avg20 else None,
        "high_52w": round(hi, 4),
        "low_52w": round(lo, 4),
        # Negative = below the high, which is the normal case.
        "pct_from_52w_high": _pct_change(last, hi),
        "pct_from_52w_low": _pct_change(last, lo),
        # Names the window honestly when there is less than a year of bars.
        "extremes_window_sessions": len(window),
    }


def describe_trend(stats: dict) -> str | None:
    """One-line, number-carrying summary — the shape a trend claim has to take.

    Included in the payload as an example, not as a conclusion: it saves the
    model from having to phrase the obvious, and it makes the contrast with
    unfalsifiable prose ("a steady grind higher") explicit.
    """
    if not stats.get("available"):
        return None
    parts = []
    for label, key in (("1w", "return_1w_pct"), ("1m", "return_1m_pct"), ("3m", "return_3m_pct")):
        v = stats.get(key)
        if v is not None:
            parts.append(f"{label} {v:+.1f}%")
    v = stats.get("pct_vs_sma20")
    if v is not None:
        parts.append(f"{v:+.1f}% vs 20d avg")
    v = stats.get("pct_from_52w_high")
    if v is not None:
        parts.append(f"{v:+.1f}% from 52w high")
    return " · ".join(parts) if parts else None
