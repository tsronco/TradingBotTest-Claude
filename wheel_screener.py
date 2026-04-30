#!/usr/bin/env python3
"""Wheel candidate screener.

Posts a weekly Discord digest of best-looking wheel candidates for whichever
mode is selected, helping decide what to add to that mode's wheel SYMBOLS.

  - Conservative: large-cap "happy to own" universe, ~10% OTM puts, 14-28 DTE.
                   Posts to #daily-summary.
  - Aggressive:   high-IV / volatile-name universe (crypto-adjacent, EV,
                   meme, China tech, etc.), ~5% OTM puts, 7-14 DTE.
                   Posts to #aggressive-summary.

Both screeners exclude symbols already in their mode's wheel SYMBOLS so the
digest never recommends ticker the wheel is already cycling on.

Score components (per CLAUDE.md wheel criteria):
  premium_yield  = ATM-ish put bid / strike  → fatter premium relative to capital
  spread_pct     = (ask - bid) / mid         → tighter is more liquid
  budget_fit     = strike × 100 ≤ free BP    → can we actually afford to sell it

Final score = premium_yield × 100 - spread_pct × 50 + budget_fit × 5

Note: this v1 does NOT fetch earnings dates. The embed footer reminds you to
verify the earnings calendar manually (earningswhispers.com) before selling.
"""

import os
import sys
from datetime import date, timedelta

import requests
from dotenv import load_dotenv

import config
import wheel_strategy
from notifications import Color, log_event, send_embed

load_dotenv()

DATA_URL         = "https://data.alpaca.markets/v2"
OPTIONS_DATA_URL = "https://data.alpaca.markets/v1beta1"

# Default conservative universe (large-cap "happy to own"). Used when the
# selected mode's screener_universe config field is None.
DEFAULT_CONSERVATIVE_UNIVERSE = sorted({
    # Tech mega-cap
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AMD",
    "INTC", "ORCL", "CRM", "ADBE", "IBM", "CSCO", "MU", "AVGO",
    # Banks / finance
    "JPM", "WFC", "C", "GS", "AXP", "V", "MA",
    # Energy
    "CVX", "COP",
    # Consumer
    "PEP", "WMT", "COST", "NKE", "MCD", "SBUX", "HD", "DIS",
    # Telecom
    "T", "VZ",
    # Healthcare (mature large-cap; no biotech)
    "JNJ", "UNH", "MRK", "ABBV", "PFE",
    # Auto / industrial
    "F", "GM", "CAT", "DE",
    # Mobility
    "UBER",
})

# ── Constants (apply uniformly within a mode) ─────────────────────────────
TOP_N           = 10
MIN_STOCK_PRICE = 5.0   # below this, options are usually too thin


# ── Mode-aware globals ────────────────────────────────────────────────────

API_KEY     = None
API_SECRET  = None
BASE_URL    = None
HEADERS     = None
UNIVERSE    = None
ALREADY_WHEELED = None
TARGET_DTE_MIN  = None
TARGET_DTE_MAX  = None
PUT_STRIKE_DISCOUNT = None
SUMMARY_CH  = None
ERRORS_CH   = None
ACTIONS_CH  = None
LOG_STREAM  = None
MODE        = None


def apply_mode(mode_name: str) -> None:
    """Switch the screener to the given mode. Loads the mode's universe,
    DTE window, strike percent, Discord channels, and Alpaca credentials.

    Mutates wheel_strategy as a side effect (so its SYMBOLS list reflects
    the right mode's wheel) — that's needed because this script imports
    SYMBOLS from wheel_strategy to build ALREADY_WHEELED.
    """
    global API_KEY, API_SECRET, BASE_URL, HEADERS
    global UNIVERSE, ALREADY_WHEELED
    global TARGET_DTE_MIN, TARGET_DTE_MAX, PUT_STRIKE_DISCOUNT
    global SUMMARY_CH, ERRORS_CH, ACTIONS_CH, LOG_STREAM, MODE

    cfg = config.get_mode(mode_name)
    MODE = mode_name

    API_KEY    = os.getenv(cfg["alpaca_key_env"])
    API_SECRET = os.getenv(cfg["alpaca_secret_env"])
    BASE_URL   = os.getenv(cfg["alpaca_url_env"], "https://paper-api.alpaca.markets/v2")
    HEADERS    = {
        "APCA-API-KEY-ID":     API_KEY,
        "APCA-API-SECRET-KEY": API_SECRET,
        "accept":              "application/json",
    }

    # Make wheel_strategy reflect this mode so we read the right SYMBOLS list
    wheel_strategy.apply_mode(mode_name)
    ALREADY_WHEELED = set(wheel_strategy.SYMBOLS)

    # Universe: mode-specific override or fall through to conservative default
    raw_universe = cfg["screener_universe"] or DEFAULT_CONSERVATIVE_UNIVERSE
    UNIVERSE = sorted(set(raw_universe) - ALREADY_WHEELED)

    PUT_STRIKE_DISCOUNT = cfg["screener_strike_pct"]
    TARGET_DTE_MIN      = cfg["screener_dte_min"]
    TARGET_DTE_MAX      = cfg["screener_dte_max"]

    SUMMARY_CH = cfg["summary_channel"]
    ERRORS_CH  = cfg["errors_channel"]
    ACTIONS_CH = cfg["actions_channel"]
    LOG_STREAM = cfg["log_stream"]


apply_mode(config.DEFAULT_MODE)


# ── Logging ────────────────────────────────────────────────────────────────


def log(msg: str) -> None:
    print(msg, flush=True)


# ── Alpaca helpers ─────────────────────────────────────────────────────────


def api_get(path, params=None):
    resp = requests.get(f"{BASE_URL}{path}", headers=HEADERS, params=params or {}, timeout=20)
    resp.raise_for_status()
    return resp.json()


def get_account():
    return api_get("/account")


def get_latest_stock_price(symbol):
    """Last trade price for a stock symbol, or None on failure."""
    try:
        resp = requests.get(
            f"{DATA_URL}/stocks/{symbol}/trades/latest",
            headers=HEADERS,
            params={"feed": "iex"},
            timeout=10,
        )
        resp.raise_for_status()
        return float(resp.json()["trade"]["p"])
    except Exception as exc:
        log(f"  [{symbol}] price lookup failed: {type(exc).__name__}: {exc}")
        return None


def round_strike(target: float, reference_price: float) -> float:
    """Standard option-chain strike spacing: $1 under $25, $5 at/above."""
    inc = 1.0 if reference_price < 25 else 5.0
    return round(target / inc) * inc


def find_best_put(symbol: str, target_strike: float):
    """Pick the contract closest to target strike + middle of DTE window."""
    today = date.today()
    exp_min = (today + timedelta(days=TARGET_DTE_MIN)).isoformat()
    exp_max = (today + timedelta(days=TARGET_DTE_MAX)).isoformat()
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
    target_exp = today + timedelta(days=(TARGET_DTE_MIN + TARGET_DTE_MAX) // 2)

    def closeness(c):
        strike_diff = abs(float(c["strike_price"]) - target_strike)
        exp_diff    = abs((date.fromisoformat(c["expiration_date"]) - target_exp).days)
        return strike_diff * 2 + exp_diff
    return min(contracts, key=closeness)


def get_option_quote(option_symbol: str):
    """Returns {'bid': float, 'ask': float} or None if no quote available."""
    try:
        resp = requests.get(
            f"{OPTIONS_DATA_URL}/options/quotes/latest",
            headers=HEADERS,
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


# ── Scoring ────────────────────────────────────────────────────────────────


def score_candidate(symbol: str, free_bp: float):
    """Score a single ticker. Returns dict on success, None on missing data."""
    price = get_latest_stock_price(symbol)
    if price is None or price < MIN_STOCK_PRICE:
        return None

    target_strike = round_strike(price * (1 - PUT_STRIKE_DISCOUNT), price)
    contract      = find_best_put(symbol, target_strike)
    if contract is None:
        return None

    quote = get_option_quote(contract["symbol"])
    if quote is None:
        return None

    bid    = quote["bid"]
    ask    = quote["ask"]
    mid    = (bid + ask) / 2
    if mid <= 0:
        return None

    strike        = float(contract["strike_price"])
    premium_yield = bid / strike
    spread_pct    = (ask - bid) / mid
    collateral    = strike * 100
    budget_fit    = 1.0 if collateral <= free_bp else 0.0
    score         = premium_yield * 100 - spread_pct * 50 + budget_fit * 5

    return {
        "symbol":        symbol,
        "price":         price,
        "strike":        strike,
        "expiry":        contract["expiration_date"],
        "option_symbol": contract["symbol"],
        "bid":           bid,
        "ask":           ask,
        "mid":           mid,
        "premium_yield": premium_yield,
        "spread_pct":    spread_pct,
        "collateral":    collateral,
        "budget_fit":    bool(budget_fit),
        "score":         score,
    }


# ── Top-level run ──────────────────────────────────────────────────────────


def build_embed_lines(top):
    lines = []
    for i, r in enumerate(top, 1):
        fit = "fits BP" if r["budget_fit"] else "OVER BP"
        lines.append(
            f"**{i}. {r['symbol']}** @ ${r['price']:.2f} → ${r['strike']:.0f}P {r['expiry']}\n"
            f"  premium ${r['mid']*100:.0f} (yield {r['premium_yield']*100:.2f}%) · "
            f"spread {r['spread_pct']*100:.1f}% · {fit}"
        )
    return lines


def run_screener():
    try:
        account = get_account()
        free_bp = float(account.get("options_buying_power", 0))
        log(f"[{MODE}] Free options buying power: ${free_bp:,.2f}")
        log(f"[{MODE}] Universe ({len(UNIVERSE)} symbols, excludes {sorted(ALREADY_WHEELED)})")

        results = []
        for symbol in UNIVERSE:
            try:
                r = score_candidate(symbol, free_bp)
                if r:
                    results.append(r)
                    log(f"  [{symbol}] score={r['score']:.2f} yield={r['premium_yield']*100:.2f}% spread={r['spread_pct']*100:.1f}%")
                else:
                    log(f"  [{symbol}] skipped — no usable data")
            except Exception as exc:
                log(f"  [{symbol}] error: {type(exc).__name__}: {exc}")

        results.sort(key=lambda r: r["score"], reverse=True)
        top = results[:TOP_N]

        title_prefix = "Aggressive Wheel Screener" if MODE == "aggressive" else "Wheel Screener"

        if not top:
            send_embed(
                SUMMARY_CH, f"{title_prefix}: no candidates",
                color=Color.YELLOW,
                description="Universe screened but no candidates returned data. Check errors channel.",
                footer="wheel_screener.py",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "wheel_screener.py", "screener_complete",
                      result="success",
                      details={"mode": MODE, "universe_size": len(UNIVERSE),
                               "scored": 0, "top_n": 0})
            return

        send_embed(
            SUMMARY_CH, f"{title_prefix} — Top {len(top)} candidates",
            color=Color.BLUE,
            description="\n\n".join(build_embed_lines(top))[:3900],
            fields=[
                {"name": "Mode",          "value": MODE,                  "inline": True},
                {"name": "Universe size", "value": str(len(UNIVERSE)),    "inline": True},
                {"name": "Returned data", "value": str(len(results)),     "inline": True},
                {"name": "DTE window",    "value": f"{TARGET_DTE_MIN}-{TARGET_DTE_MAX}d", "inline": True},
                {"name": "Strike target", "value": f"{PUT_STRIKE_DISCOUNT*100:.0f}% OTM", "inline": True},
                {"name": "Free BP",       "value": f"${free_bp:,.0f}",    "inline": True},
            ],
            footer="wheel_screener.py · verify earnings calendar before selling",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "wheel_screener.py", "screener_complete",
                  result="success",
                  details={
                      "mode":          MODE,
                      "universe_size": len(UNIVERSE),
                      "scored":        len(results),
                      "top_n":         len(top),
                      "top_symbols":   [r["symbol"] for r in top],
                  })
    except Exception as exc:
        send_embed(
            ERRORS_CH, "wheel_screener.py crashed",
            color=Color.RED,
            description=f"`{type(exc).__name__}: {str(exc)[:500]}`",
            footer="wheel_screener.py",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "wheel_screener.py", "exception",
                  result="failure", notes=f"{type(exc).__name__}: {str(exc)[:500]}")
        raise


if __name__ == "__main__":
    selected_mode, _remaining = config.parse_mode_arg(sys.argv[1:])
    apply_mode(selected_mode)
    run_screener()
