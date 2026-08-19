"""Configuration for the autonomous agent paper account.

This account is NOT a wheel mode. It does not use strategy.py, wheel_strategy.py,
or the screener. Claude (Opus, via the Anthropic API) makes every trading
decision — what to trade, which structure, how big, when to enter, and when to
exit — across the full options + stock toolbox. `agent_trader.py` is its harness.

Kept deliberately SEPARATE from `config.MODES` (which is locked to the two wheel
accounts, manual + live, and whose entries all carry the wheel parameter surface)
because the agent shares none of that surface. The shared read-only infra
recognizes the "agent" string so the rest of the system can refer to this account
uniformly:
  - alpaca_data._credentials("agent") → ALPACA_AGENT_* creds (paper endpoint)
  - notifications channel map → the four #agent-* Discord webhooks
  - log stream "agent" → logs/agent.jsonl

Paper only. Real money is a separate future decision, gated on validation.

Provisioning (out of code scope — Tim):
  - Alpaca paper MARGIN sub-account, ~$2,000 seed.
  - GitHub Actions secrets: ALPACA_AGENT_API_KEY / _API_SECRET / _BASE_URL.
  - Discord: #agent-trades / -summary / -errors / -actions + their webhook secrets
    (DISCORD_AGENT_TRADES_WEBHOOK, _SUMMARY_, _ERRORS_, _ACTIONS_).
  - ANTHROPIC_API_KEY available to the workflow (already a repo secret).
"""
import os


MODE = "agent"

# Default decision model. Opus per Tim's call — the entire value of this account
# is Claude's judgment across complex structures, so it runs on the most capable
# model. Overridable via the AGENT_MODEL env var (e.g. to pin a version or drop
# to a cheaper model for a cost comparison) without a code change.
DEFAULT_MODEL = "claude-opus-5"


AGENT_CONFIG = {
    # ── Alpaca — paper margin account, its own credential set ──────────────
    "alpaca_key_env":    "ALPACA_AGENT_API_KEY",
    "alpaca_secret_env": "ALPACA_AGENT_API_SECRET",
    "alpaca_url_env":    "ALPACA_AGENT_BASE_URL",

    # ── Discord — its own four channels ────────────────────────────────────
    "trades_channel":  "agent_trades",
    "summary_channel": "agent_summary",
    "errors_channel":  "agent_errors",
    "actions_channel": "agent_actions",

    "log_stream": "agent",

    # ── State ──────────────────────────────────────────────────────────────
    # One file holds the whole account model: open positions with their attached
    # entry theses, closed-trade lesson records, and the day-trade / metadata
    # bookkeeping. Committed back to the repo each cycle like the wheel state.
    "state_file": "agent_state.json",

    # ── Decision brain ─────────────────────────────────────────────────────
    "model_env":            "AGENT_MODEL",   # optional override of DEFAULT_MODEL
    "max_decision_tokens":  4096,

    # ── Education brain (hindsight grading + weekly retrospective) ──────────
    # Grading is a cheaper judgment task than the trade decision, so it runs on
    # Sonnet by default (matches the dashboard's grading tier). Overridable via
    # AGENT_GRADER_MODEL. The retrospective reuses the grader model.
    "grader_model_env":      "AGENT_GRADER_MODEL",
    "max_grade_tokens":      1024,
    "max_retro_tokens":      2048,
    # How many days of closed-trade lesson records the weekly retrospective
    # reads. 7 = the past week; the digest still notes the running total.
    "retro_window_days":     7,

    # ── Capital + the single soft guard ────────────────────────────────────
    "seed_capital": 2000,
    # Soft circuit breaker: when equity is below this, the harness blocks new
    # OPENS but still lets Claude CLOSE — so a drawdown leaves a runnable,
    # observable account instead of a blown-up one. The only non-mechanical
    # limit in the design (with PDT gone, there is no day-trade rail). Set to 0
    # to disable entirely.
    "equity_floor": 500,

    # ── Candidate universe (context only) ──────────────────────────────────
    # The wide field Claude scans each cycle. This does NOT explode cost: the
    # cycle is two-phase — a cheap batched QUOTE pull for the whole universe
    # (breadth), then Claude picks a small shortlist and we fetch full option
    # CHAINS only for those (depth). So the universe can be large and liquid
    # without every cycle carrying 250 chains. Set to AGENT_UNIVERSE below.
    "universe": None,

    # ── Two-phase scan knobs ───────────────────────────────────────────────
    # Depth is bounded by the focus shortlist, not the universe size. Claude
    # may name up to this many symbols to analyze deeply per cycle (held
    # positions are always included on top of these).
    "max_focus_symbols": 12,
    "max_focus_tokens":  1200,   # the focus/shortlist call is small + cheap
    "breadth_chunk_size": 100,   # symbols per batched snapshot request

    # ── Cost control ───────────────────────────────────────────────────────
    # The decision call's option-chain payload dominates spend: it scales as
    # focus_symbols x chain_keep, and at 24 x 40 it was ~43k input tokens per
    # cycle on Opus. These two numbers are the main dial.
    "chain_keep": 14,          # option rows per symbol, nearest the money
    # The focus step is a shortlist pick over quotes — a cheap judgment task
    # that does not need the decision model. Sonnet keeps the same request
    # shape (adaptive thinking + effort) at a fraction of the price.
    "focus_model_env": "AGENT_FOCUS_MODEL",
    # Reasoning depth per call. Thinking tokens bill as output.
    #
    # Focus is a shortlist pick off a quote table — a genuinely simple task, and
    # `low` is what that tier is for.
    #
    # The DECISION stays at `high` deliberately. It was briefly dropped to
    # `medium` during the 2026-08-19 cost pass, which was the wrong knob to
    # touch: once the chain payload was trimmed, the gap between medium and high
    # is ~$0.04/cycle — about $3/month at 4 fires a day — and the trade decision
    # is the entire product of this account. Anthropic's own guidance is a
    # minimum of `high` for intelligence-sensitive work. Spend on the payload,
    # not on thinking less about the trade.
    #
    # NB `max_decision_tokens` (4096) bounds thinking AND the response together.
    # High leaves roughly 3k for reasoning after the thesis prose; going to
    # `xhigh`/`max` would need that raised first or the tool call can truncate.
    "focus_effort": "low",
    "decision_effort": "high",

    # ── API resilience ─────────────────────────────────────────────────────
    # The Anthropic SDK retries connection errors, 408/409/429 and 5xx (which
    # includes 529 overloaded_error) with exponential backoff, but only twice by
    # default — roughly a couple of seconds of cover. A capacity blip lasting
    # longer than that killed whole cycles on 2026-08-18. Since this account
    # runs hourly and has nothing else to do while it waits, spending a bit
    # longer here is strictly better than losing the hour.
    "max_retries": 8,
    # Outer retry around the DECISION call specifically, on top of the SDK's own
    # backoff. Losing the focus call costs a shortlist (there's a fallback);
    # losing the decision call costs the entire cycle, so it gets a second,
    # wider-spaced line of defence.
    "decision_retries": 3,
    "decision_retry_backoff_seconds": 20,

    # ── Cadence (informational; the cron is the source of truth) ───────────
    "cadence": "every 2 hours",
}


# ── Candidate universe ─────────────────────────────────────────────────────
# ~250 highly liquid, optionable US names + the most liquid ETFs, spread across
# every sector so Claude has a genuinely wide field to choose from. Membership
# here is NOT a recommendation — it's only "these have quotes + tradeable option
# chains worth looking at." Claude decides what (if anything) to do with any of
# them. Expand or prune freely; keep additions liquid and optionable so the
# agent never gets handed a junk chain it can't price. Because the scan is
# two-phase (quotes for all, chains only for the shortlist), growing this list
# costs only a few hundred tokens of quotes per cycle.
AGENT_UNIVERSE = [
    # Mega-cap tech + semiconductors
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "AVGO", "ORCL",
    "ADBE", "CRM", "CSCO", "ACN", "IBM", "INTC", "AMD", "QCOM", "TXN", "INTU",
    "NOW", "AMAT", "MU", "LRCX", "ADI", "KLAC", "SNPS", "CDNS", "MRVL", "NXPI",
    "ON", "MCHP", "ARM", "PLTR", "SMCI", "DELL", "HPQ", "ANET", "TSM",
    # Software / internet / high-growth
    "SHOP", "SNOW", "NET", "DDOG", "PANW", "ZS", "FTNT", "MDB", "TEAM", "WDAY",
    "ABNB", "UBER", "LYFT", "DASH", "COIN", "HOOD", "PYPL", "ROKU", "PINS",
    "SNAP", "SPOT", "NFLX", "DIS", "WBD", "PARA", "DOCU", "OKTA", "TWLO",
    "RBLX", "DKNG",
    # Financials
    "JPM", "BAC", "WFC", "C", "GS", "MS", "USB", "PNC", "TFC", "SCHW", "AXP",
    "V", "MA", "BLK", "BX", "KKR", "COF", "BK", "CME", "ICE", "SPGI", "MMC",
    "AIG", "MET", "PRU", "ALL", "PGR", "TRV", "HBAN", "KEY", "RF", "FITB",
    "ALLY", "SOFI",
    # Energy
    "XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX", "VLO", "OXY", "WMB",
    "KMI", "DVN", "HAL", "BKR", "HES", "FANG", "OKE", "LNG", "BP", "SHEL",
    # Healthcare
    "UNH", "JNJ", "LLY", "ABBV", "MRK", "PFE", "TMO", "ABT", "DHR", "BMY",
    "AMGN", "GILD", "CVS", "MDT", "ISRG", "VRTX", "REGN", "ELV", "CI", "HUM",
    "ZTS", "BSX", "SYK", "MRNA", "BIIB",
    # Consumer discretionary
    "HD", "LOW", "MCD", "SBUX", "NKE", "TJX", "BKNG", "CMG", "ORLY", "AZO",
    "ROST", "YUM", "MAR", "HLT", "GM", "F", "RIVN", "LCID", "CCL", "RCL",
    "NCLH", "DAL", "UAL", "AAL", "LUV", "EBAY", "LULU", "DECK",
    # Consumer staples
    "WMT", "COST", "PG", "KO", "PEP", "PM", "MO", "MDLZ", "CL", "KMB", "GIS",
    "KHC", "TGT", "KR", "STZ", "EL", "MNST", "KDP",
    # Industrials
    "CAT", "DE", "BA", "GE", "HON", "UNP", "UPS", "FDX", "LMT", "RTX", "GD",
    "NOC", "MMM", "EMR", "ETN", "ITW", "CSX", "NSC", "WM", "PCAR", "CMI", "GEV",
    # Communication / telecom
    "T", "VZ", "TMUS", "CMCSA", "CHTR",
    # Materials
    "LIN", "APD", "SHW", "FCX", "NEM", "NUE", "DOW", "VALE", "GOLD", "CF", "ALB",
    # Real estate
    "PLD", "AMT", "EQIX", "O", "SPG", "CCI",
    # Utilities
    "NEE", "DUK", "SO", "D", "AEP",
    # Liquid China / international ADRs
    "BABA", "JD", "PDD", "NIO", "BIDU", "LI",
    # Most-liquid ETFs (index, sector, and thematic)
    "SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "SMH", "ARKK", "GLD",
    "SLV", "TLT", "HYG", "EEM", "FXI", "USO", "EWZ", "XBI", "XLV", "XOP",
    "KRE", "XLU", "XLI", "XLP",
]


def get() -> dict:
    """Return the agent account config dict."""
    return AGENT_CONFIG


DEFAULT_GRADER_MODEL = "claude-sonnet-5"
DEFAULT_FOCUS_MODEL = "claude-sonnet-5"


def model() -> str:
    """Resolved decision model — env override (AGENT_MODEL) or DEFAULT_MODEL."""
    return os.getenv(AGENT_CONFIG["model_env"]) or DEFAULT_MODEL


def focus_model() -> str:
    """Model for the phase-1 shortlist pick. Cheaper than the decision model on
    purpose — picking names off a quote list is not the hard part of a cycle."""
    return os.getenv(AGENT_CONFIG["focus_model_env"]) or DEFAULT_FOCUS_MODEL


def grader_model() -> str:
    """Resolved grading/retrospective model — env override or DEFAULT_GRADER_MODEL."""
    return os.getenv(AGENT_CONFIG["grader_model_env"]) or DEFAULT_GRADER_MODEL


def client(**overrides):
    """The Anthropic client every agent module should use.

    Centralized so the retry posture is set in ONE place: all four call sites
    (decisions, focus, grading, retrospective) previously built a bare
    `anthropic.Anthropic()` with the SDK default of 2 retries, which is not
    enough cover for a transient 529.

    Imported lazily so `agent_config` stays importable (and testable) without
    the SDK installed.
    """
    import anthropic
    kwargs = {"max_retries": AGENT_CONFIG["max_retries"]}
    kwargs.update(overrides)
    return anthropic.Anthropic(**kwargs)


def credentials_env() -> tuple[str, str, str]:
    """(key_env, secret_env, url_env) names for the agent Alpaca account."""
    return (
        AGENT_CONFIG["alpaca_key_env"],
        AGENT_CONFIG["alpaca_secret_env"],
        AGENT_CONFIG["alpaca_url_env"],
    )


# Point the config's universe at the dedicated agent list. Kept as a separate
# assignment (rather than inline in the dict) so the list can live below its
# own long comment block. The agent runs none of the screener/wheel machinery;
# this is purely the candidate pool the two-phase scan draws quotes from.
AGENT_CONFIG["universe"] = list(AGENT_UNIVERSE)
