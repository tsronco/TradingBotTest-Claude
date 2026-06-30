"""Mode configuration for the paper + live account architecture.

Two accounts run side-by-side, fully isolated. One is paper; one is live.

  manual       — bot manages whatever you buy by hand: trail/ladder/stop on every
                 stock you hold (auto-discovered from positions), and the wheel
                 manages existing puts (50% close) + sells covered calls on
                 assignments — but never opens new puts itself.
                 Discord: #manual-trades, #manual-summary, #manual-errors,
                          #manual-actions
                 Alpaca:  ALPACA_MANUAL_API_KEY / ALPACA_MANUAL_API_SECRET (paper)

  live         — REAL MONEY. Identical behaviour to manual mode (auto-discover
                 from positions, never open new puts, manage what the user opens
                 by hand). Separate Alpaca live credentials, separate Discord
                 channels, separate state files.
                 Discord: #live-trades, #live-summary, #live-errors, #live-actions
                 Alpaca:  ALPACA_LIVE_API_KEY / ALPACA_LIVE_API_SECRET (live)

Each script reads --mode {manual|live} on its CLI; the mode picks the
credentials, state files, log stream, Discord channels, and parameters.

Both modes auto-discover symbols from held positions, so there is no static
symbol list to maintain.

(History: conservative, aggressive, and three small-account paper accounts —
sm500/sm1000/sm2000 — were retired 2026-06-29. The shared strategy/wheel/
auto-spread engine they exercised is unchanged; only the account rows, their
workflows, credentials, and Discord channels were removed.)
"""

# ── Mode definitions ──────────────────────────────────────────────────────

MODES = {
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

        # Symbols the bot must leave completely alone on this account, even
        # though it auto-discovers from positions. Both strategy.py (no
        # trail/ladder/stop) and wheel_strategy.py (no covered-call sale on
        # assignment, no put management) skip any symbol listed here. Used to
        # hand a position back to manual control so the user can exit it
        # themselves without the bot re-entering or covering it.
        #
        # (SNAP was excluded 2026-06-19 after an underwater 100-share
        # assignment; removed 2026-06-30 once that position was closed out, so
        # nothing is currently hand-held back from the bot on manual.)
        "excluded_symbols":    [],

        # Wheel never opens Stage 1 puts on this account. Existing puts are
        # still managed (50% close) and assignments still trigger Stage 2
        # covered call sales.
        "wheel_skip_new_puts": True,

        # Spread management is enabled on the manual paper account so the
        # bot manages user-opened credit/debit spreads (early close + stop
        # loss + DTE floor). Conservative/aggressive/live stay False.
        "spread_management":      True,
        "spread_early_close_pct": 0.50,
        # Stop-loss loosened 0.50 → 0.75 on 2026-05-22 evening after MU
        # auto-open stopped out 19 minutes after entry on routine 1%
        # intraday noise. At Δ −0.40 short delta the spread lives close
        # enough to ITM that a 50%-max-loss trigger fires on transient
        # moves that would reverse later. 0.75 gives theta more room to
        # work; downside is bigger realized loss per stop ($375 vs $250
        # on a $500 max-loss spread). Tradeoff: lower stop-out frequency
        # at the cost of larger loss when a real adverse move materializes.
        # Manual-only — SM modes keep their tighter 0.50 + 2× credit stop.
        "spread_stop_loss_pct":   0.75,
        "spread_dte_floor":       2,

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

        # ── Auto-open spreads (enabled 2026-05-22 — shortcut $10k validation
        # of the SM auto-spread engine on existing manual infrastructure)
        # ───────────────────────────────────────────────────────────────────
        # Mixes bot-opens with user hand-opens on the same account. Both
        # flow through the same handle_spread management path (50% profit
        # close, 2× credit stop, DTE floor); the distinguisher is the
        # `open_order_id` field on bot-opened spreads (None on hand-opened
        # / adopted spreads).
        #
        # Balanced posture (same as sm1000/sm2000) — at $10k equity the
        # 10% risk cap is $1,000, comfortably fits any $5-wide spread.
        #
        # DISABLED 2026-06-03 (PDT): the manual account is a margin account
        # under $25k, so same-day round trips by the auto-opener tripped
        # Alpaca's Pattern Day Trading protection (code 40310100). Once
        # flagged, EVERY further order — including the closes the manager
        # needs — is denied, which 403-looped a stuck NVDA spread close every
        # cycle. Autonomous same-day spread churn is structurally
        # incompatible with a sub-$25k margin account. Hand-opened/adopted
        # spreads are still managed normally; only the bot-opener is off.
        "auto_open_spreads":         False,
        # bp_switch_threshold is the BP below which the engine prefers a
        # spread over a CSP. Inherited as 5000 from the SM Balanced posture,
        # but on a $10k manual account BP usually sits well above that — the
        # gate would block every spread open. wheel_skip_new_puts is True on
        # manual so a CSP would never be opened either; net effect with the
        # inherited threshold was "auto-open does nothing." Bumped to 50000
        # (effectively disabled) so the spread path is always taken when
        # auto_open_spreads is True. (2026-05-22)
        "bp_switch_threshold":       50000,
        "wheelability_min":          80,
        "wheelability_min_pool":     5,       # R12: don't trust the percentile floor on a tiny eligible pool
        "max_risk_pct_equity":       0.10,
        "min_net_credit":            0.05,
        "max_concurrent_spreads":    4,       # 10x sm2000 capital → +1 vs sm2000
        "account_floor":             1000,    # 10x sm levels (skip if equity < $1k)
        "earnings_exclusion_days":   7,
        # 2 opens/cycle so a single-stock spread + a bypass ETF spread can
        # both fill on the same cycle. Without this, the score-race winner
        # always grabs the only slot and ETFs (which sit at the bottom of
        # the sort with low premium-yield scores) never get reached. Risk
        # cap + concurrency cap + credit-to-width gate still limit total
        # exposure. Manual-only — SM/cons/agg/live stay at 1.
        "max_opens_per_cycle":       2,
        "short_put_otm_pct":         0.10,
        "spread_dte_min":            14,
        "spread_dte_max":            28,
        "max_underlying_price":      None,    # no price filter at this capital level

        # Delta-based short-leg selection (2026-05-22). When set, overrides
        # the static `short_put_otm_pct` rule. The 10%-OTM rule is calibrated
        # for high-IV single stocks; on a low-IV ETF (QQQ/SPY/IWM) 10% OTM
        # lands at Δ ≈ −0.03 with negligible premium. Targeting Δ −0.40
        # self-calibrates across IV regimes: same anchor produces a 10%-OTM
        # strike on a high-IV cheap stock and a near-ATM strike on a low-IV
        # ETF, so credit-to-width passes for both. Manual-only — cons/agg/
        # live/SM modes leave this unset and fall back to OTM-pct selection.
        "short_put_target_delta":    -0.40,

        # ETF wheelability bypass (2026-05-22). The percentile-80 floor
        # exists to skip "obviously bad" candidates in a single-stock pool.
        # ETFs always score low on `premium_yield = bid/strike` (denominator
        # is hundreds of dollars), so they'd never clear the floor even with
        # delta-targeting. Bypass keeps the percentile filter for single
        # stocks but lets ETFs proceed to construction, where the 33%
        # credit-to-width gate + risk cap + trend filter + BP + earnings
        # do the real quality work.
        "wheelability_bypass_symbols": ["QQQ", "SPY", "IWM"],

        # Opener-side hardened-engine guards (mirror sm1000/sm2000 Balanced
        # posture). Manual keeps its looser 0.75-of-max-loss stop *threshold*
        # (not retightened to the SM 2× credit stop) so hand-opened spreads
        # aren't surprised mid-trade — but as of 2026-05-30 the stop is judged
        # on the MID (quote-noise-robust) and the underlying-price tripwire is
        # ON, because manual bot-opened spreads were losing on every trade:
        # a wide bid/ask was tripping the stop on quote noise minutes after a
        # bad fill (MU −$175 in 20 min). The tripwire only closes when the
        # stock actually trades through the short strike — pure risk
        # protection, applies to all manual spreads.
        "min_credit_to_width_pct":   0.33,
        "trend_filter":              True,
        "spread_underlying_tripwire": True,   # close if stock crosses short strike
        # Tripwire noise tolerance (2026-06-16). A defined-risk spread's loss is
        # capped at the width regardless of intraday wicks, so closing on the
        # first strike touch at any DTE realized near-max losses on noise that
        # recovered within an hour or two (MU 2-DTE, QQQ 9-DTE 2026-06-16). Only
        # arm the tripwire in the final 2 days (where ITM = real pin/assignment
        # risk) AND require the stock to hold through the short strike for a full
        # hour of continuous breach before closing. Manual-only — SM/cons/agg/
        # live leave these unset (None/0) and keep immediate-fire-at-all-DTE.
        "spread_tripwire_dte":             2,
        "spread_tripwire_confirm_minutes": 60,
        "spread_settle_minutes":      20,     # no loss-stop in first 20 min post-open
        # Opening-price posture (2026-05-30). Rest the mleg between the mid and
        # the marketable cross instead of crossing fully and giving away the
        # whole bid/ask width on entry. 0.40 = give up 40% of the gap toward
        # marketable; never accept < 60% of the mid (skip rather than open a
        # giveaway). The pending-order machinery handles a resting unfilled
        # order, so non-fills are harmless.
        "spread_open_concession_pct":        0.40,
        "spread_open_min_credit_pct_of_mid": 0.60,
    },

    "live": {
        # REAL MONEY. Behaviour identical to manual mode — bot only manages
        # positions the user opens by hand and never opens new Stage 1 puts.
        # Credentials, state files, log stream, and Discord channels are all
        # independent of the three paper accounts.
        "alpaca_key_env":    "ALPACA_LIVE_API_KEY",
        "alpaca_secret_env": "ALPACA_LIVE_API_SECRET",
        "alpaca_url_env":    "ALPACA_LIVE_BASE_URL",

        "trades_channel":    "live_trades",
        "summary_channel":   "live_summary",
        "errors_channel":    "live_errors",
        "actions_channel":   "live_actions",

        "log_stream":        "live",

        "wheel_state_file":     "wheel_state_live.json",
        "strategy_state_file":  "strategy_state_live.json",

        # Auto-discover symbols from live Alpaca positions (no static list).
        "wheel_symbols":       [],
        "auto_discover_symbols": True,

        # Never open Stage 1 puts. Manage existing puts (50% close) and sell
        # covered calls on assignment, same as manual mode.
        "wheel_skip_new_puts": True,

        # Spread management — gated off on live for now. Future plan flips
        # this on after at least two weeks of manual paper validation.
        "spread_management":      False,
        "spread_early_close_pct": 0.50,
        "spread_stop_loss_pct":   0.50,
        "spread_dte_floor":       2,

        # Wheel parameters mirror conservative/manual — used for the 50% close
        # on existing puts and for pricing the covered call when an assignment
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

DEFAULT_MODE = "manual"


def get_mode(mode_name: str) -> dict:
    """Return the config dict for the given mode. Raises ValueError if unknown."""
    if mode_name not in MODES:
        valid = ", ".join(sorted(MODES))
        raise ValueError(f"Unknown mode '{mode_name}'. Valid: {valid}")
    return MODES[mode_name]


def excluded_symbols(mode_name: str) -> set:
    """Uppercased set of symbols the bot must leave alone in `mode_name`.

    Defaults to an empty set for any mode that doesn't define the key, so
    live is unaffected unless explicitly opted in.
    """
    raw = get_mode(mode_name).get("excluded_symbols", []) or []
    return {str(s).strip().upper() for s in raw if str(s).strip()}


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


# ── Late binding for SM_CURATED_UNIVERSE ─────────────────────────────────
# screener_core imports config in some paths; we set the universe pointer
# after MODES is built to keep the import graph one-directional.
# Manual auto-spread shortcut (2026-05-22) shares the curated universe so the
# $10k validation runs against the same scoring distribution. (The SM accounts
# this universe was first built for were retired 2026-06-29; the universe and
# the auto-spread engine stay — manual still references them.)
from screener_core import SM_CURATED_UNIVERSE as _SM_CURATED_UNIVERSE
MODES["manual"]["screener_universe"] = _SM_CURATED_UNIVERSE
