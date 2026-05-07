"""Mode configuration for the multi paper-account architecture.

Three paper accounts run side-by-side, fully isolated:

  conservative — original wheel, 10% OTM, 14-28 DTE puts, 50% early close
                 Symbols: large-caps + a few cheap names for small-account practice.
                 Discord: #tsla-trades, #daily-summary, #errors, #all-actions
                 Alpaca:  ALPACA_API_KEY / ALPACA_API_SECRET

  aggressive   — wheel cycling faster on higher-IV names. 5% OTM, 7-14 DTE puts,
                 60% early close. Mirrors the conservative architecture (also
                 runs strategy.py + long_options_strategy.py) — only the wheel
                 parameters and symbol mix differ.
                 Discord: #aggressive-trades, #aggressive-summary, #aggressive-errors,
                          #aggressive-actions
                 Alpaca:  ALPACA_AGG_API_KEY / ALPACA_AGG_API_SECRET

  manual       — bot manages whatever you buy by hand: trail/ladder/stop on every
                 stock you hold (auto-discovered from positions), and the wheel
                 manages existing puts (50% close) + sells covered calls on
                 assignments — but never opens new puts itself. Wheel parameters
                 mirror conservative for managing positions.
                 Discord: #manual-trades, #manual-summary, #manual-errors,
                          #manual-actions
                 Alpaca:  ALPACA_MANUAL_API_KEY / ALPACA_MANUAL_API_SECRET

Each script reads --mode {conservative|aggressive|manual} on its CLI; the mode
picks the credentials, state files, log stream, Discord channels, and parameters.

To add/remove a wheel symbol, edit CONSERVATIVE_SYMBOLS or AGGRESSIVE_SYMBOLS
and that's the entire config change. Manual mode auto-discovers symbols from
held positions, so it has no symbol list.
"""

# ── Wheel symbol lists ────────────────────────────────────────────────────
#
# IMPORTANT: list order = fill priority.
#
# The wheel (wheel_strategy.run_wheel) iterates SYMBOLS sequentially and
# consumes buying power as it places put orders. Symbols earlier in the
# list get first claim on cash; symbols later in the list only fill if BP
# remains. When adding/removing symbols, place them where you want them in
# the fill order.
#
# Symbols that hit insufficient cash (i.e., the wheel tried but BP was
# exhausted by earlier symbols) silently skip and route the event to the
# muted #all-actions / #aggressive-actions firehose — NOT the errors
# channel. That's intentional: running out of cash on the fallback tier
# is expected behavior, not a bug.

# Conservative: large-caps + cheap names. $100k account easily fits all 10
# puts so order doesn't really matter here — just keep them in a sensible
# arrangement. Adjust freely.
CONSERVATIVE_SYMBOLS = [
    "TSLA", "BAC", "XOM", "KO", "PLTR", "SOFI", "PFE",
    "F", "T", "INTC",
]

# Aggressive: 7 high-IV names (priority tier) + 7 baseline symbols (fallback).
#
# Order matters — the wheel iterates SYMBOLS sequentially and consumes BP as
# it places put orders. Listing aggressive names first ensures the high-IV
# tier gets first claim on the account's buying power; the baseline tier
# only fills if BP remains afterward. Symbols that hit insufficient cash
# log to #aggressive-actions (firehose, not errors) since this is expected
# behavior, not a bug.
AGGRESSIVE_SYMBOLS = [
    # Priority tier — aggressive high-IV names get first claim on BP
    "COIN", "MARA", "RIOT", "SMCI", "NVDA", "AMD", "MU",
    # Fallback tier — only fill if BP remains after priority tier
    "TSLA", "BAC", "XOM", "KO", "PLTR", "SOFI", "PFE",
]

# ── Wheel screener universes ─────────────────────────────────────────────

# Conservative screener falls through to the default UNIVERSE in
# wheel_screener.py (curated large-caps). Aggressive uses a separate
# higher-IV universe so the weekly digest highlights ticker we'd
# actually consider for the aggressive wheel.
AGGRESSIVE_SCREENER_UNIVERSE = [
    # Crypto-adjacent (extra volatile)
    "MSTR", "HOOD",
    # Volatile semis / AI
    "ARM", "ON", "AVGO",
    # EV / speculative auto
    "RIVN", "LCID", "NIO",
    # High-vol fintech / consumer
    "AFRM", "SHOP", "U", "SNAP", "ROKU", "PINS",
    # Cybersec / cloud (high IV)
    "NET", "DDOG", "CRWD", "ZS", "SNOW",
    # China tech volatility
    "BABA", "JD", "PDD",
    # Meme / social
    "GME", "AMC",
    # Volatile biopharma
    "MRNA",
]


# ── Mode definitions ──────────────────────────────────────────────────────

MODES = {
    "conservative": {
        # Alpaca env-var names (the script reads os.getenv on these)
        "alpaca_key_env":    "ALPACA_API_KEY",
        "alpaca_secret_env": "ALPACA_API_SECRET",
        "alpaca_url_env":    "ALPACA_BASE_URL",

        # Discord channel names (resolved by notifications/discord.py
        # CHANNEL_ENV_MAP into the matching webhook env var)
        "trades_channel":    "tsla",
        "summary_channel":   "summary",
        "errors_channel":    "errors",
        "actions_channel":   "actions",

        # JSONL log stream name (writes to logs/<stream>.jsonl)
        "log_stream":        "tsla",

        # State files
        "wheel_state_file":     "wheel_state.json",
        "strategy_state_file":  "strategy_state.json",

        # Wheel parameters
        "wheel_symbols":       CONSERVATIVE_SYMBOLS,
        "put_strike_pct":      0.10,
        "call_strike_pct":     0.10,
        "put_dte_min":         14,
        "put_dte_max":         28,
        "call_dte_min":         7,
        "call_dte_max":        21,
        "early_close_pct":     0.50,

        # Cancel any wheel sell-to-open order pending longer than this and
        # immediately re-quote at the fresh mid. Default: 4hr. Frees BP that
        # would otherwise stay tied up by limit orders that won't fill (e.g.,
        # mid-of-spread on illiquid options).
        "stale_after_hours":   4,

        # Screener parameters
        "screener_universe":      None,   # falls through to default
        "screener_strike_pct":    0.10,
        "screener_dte_min":       14,
        "screener_dte_max":       28,

        # Long-options parameters (TP/SL/time-exit thresholds same for both modes for now)
    },

    "aggressive": {
        "alpaca_key_env":    "ALPACA_AGG_API_KEY",
        "alpaca_secret_env": "ALPACA_AGG_API_SECRET",
        "alpaca_url_env":    "ALPACA_AGG_BASE_URL",

        "trades_channel":    "agg_trades",
        "summary_channel":   "agg_summary",
        "errors_channel":    "agg_errors",
        "actions_channel":   "agg_actions",

        "log_stream":        "tsla_aggressive",

        "wheel_state_file":     "wheel_state_aggressive.json",
        "strategy_state_file":  "strategy_state_aggressive.json",

        "wheel_symbols":       AGGRESSIVE_SYMBOLS,
        "put_strike_pct":      0.05,
        "call_strike_pct":     0.05,
        "put_dte_min":          7,
        "put_dte_max":         14,
        "call_dte_min":         5,
        "call_dte_max":        10,
        "early_close_pct":     0.40,
        "stale_after_hours":   4,

        "screener_universe":      AGGRESSIVE_SCREENER_UNIVERSE,
        "screener_strike_pct":    0.05,
        "screener_dte_min":        7,
        "screener_dte_max":       14,
    },

    "manual": {
        "alpaca_key_env":    "ALPACA_MANUAL_API_KEY",
        "alpaca_secret_env": "ALPACA_MANUAL_API_SECRET",
        "alpaca_url_env":    "ALPACA_MANUAL_BASE_URL",

        "trades_channel":    "manual_trades",
        "summary_channel":   "manual_summary",
        "errors_channel":    "manual_errors",
        "actions_channel":   "manual_actions",

        "log_stream":        "manual",

        "wheel_state_file":     "wheel_state_manual.json",
        "strategy_state_file":  "strategy_state_manual.json",

        # Manual mode auto-discovers symbols from live positions instead of
        # iterating a static list. wheel_symbols stays defined (empty) so
        # callers that read it without checking auto_discover_symbols don't
        # crash; the auto_discover_symbols flag below is what actually drives
        # behaviour in strategy.py and wheel_strategy.py.
        "wheel_symbols":       [],
        "auto_discover_symbols": True,

        # Wheel never opens Stage 1 puts on this account. Existing puts are
        # still managed (50% close) and assignments still trigger Stage 2
        # covered call sales.
        "wheel_skip_new_puts": True,

        # Wheel parameters mirror conservative — used for the 50% close on
        # existing puts and for pricing the covered call when an assignment
        # moves a position into Stage 2.
        "put_strike_pct":      0.10,
        "call_strike_pct":     0.10,
        "put_dte_min":         14,
        "put_dte_max":         28,
        "call_dte_min":         7,
        "call_dte_max":        21,
        "early_close_pct":     0.50,
        "stale_after_hours":   4,

        # Screener parameters mirror conservative. Bot doesn't auto-execute
        # but the Sunday digest still surfaces wheel candidates as ideas.
        "screener_universe":      None,
        "screener_strike_pct":    0.10,
        "screener_dte_min":       14,
        "screener_dte_max":       28,
    },
}

DEFAULT_MODE = "conservative"


def get_mode(mode_name: str) -> dict:
    """Return the config dict for the given mode. Raises ValueError if unknown."""
    if mode_name not in MODES:
        valid = ", ".join(sorted(MODES))
        raise ValueError(f"Unknown mode '{mode_name}'. Valid: {valid}")
    return MODES[mode_name]


def parse_mode_arg(argv: list[str]) -> tuple[str, list[str]]:
    """Extract --mode <name> from argv, return (mode, remaining_argv).

    If --mode is not present, returns (DEFAULT_MODE, argv unchanged).

    Used by each script's __main__ block:
        mode, args = parse_mode_arg(sys.argv[1:])
        if 'once' in args:
            run_one_cycle(mode)
    """
    remaining = []
    mode = DEFAULT_MODE
    i = 0
    while i < len(argv):
        if argv[i] == "--mode" and i + 1 < len(argv):
            mode = argv[i + 1]
            i += 2
        elif argv[i].startswith("--mode="):
            mode = argv[i].split("=", 1)[1]
            i += 1
        else:
            remaining.append(argv[i])
            i += 1
    return mode, remaining
