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

    # ── Capital + the single soft guard ────────────────────────────────────
    "seed_capital": 2000,
    # Soft circuit breaker: when equity is below this, the harness blocks new
    # OPENS but still lets Claude CLOSE — so a drawdown leaves a runnable,
    # observable account instead of a blown-up one. The only non-mechanical
    # limit in the design (with PDT gone, there is no day-trade rail). Set to 0
    # to disable entirely.
    "equity_floor": 500,

    # ── Candidate universe (context only) ──────────────────────────────────
    # Bounds the market pack we fetch each cycle (quotes + chains), NOT what
    # Claude is allowed to think about. Starts from the curated SM universe;
    # expand freely. Late-bound below to keep the import graph one-directional.
    "universe": None,

    # ── Cadence (informational; the cron is the source of truth) ───────────
    "cadence": "hourly",
}


def get() -> dict:
    """Return the agent account config dict."""
    return AGENT_CONFIG


def model() -> str:
    """Resolved decision model — env override (AGENT_MODEL) or DEFAULT_MODEL."""
    return os.getenv(AGENT_CONFIG["model_env"]) or DEFAULT_MODEL


def credentials_env() -> tuple[str, str, str]:
    """(key_env, secret_env, url_env) names for the agent Alpaca account."""
    return (
        AGENT_CONFIG["alpaca_key_env"],
        AGENT_CONFIG["alpaca_secret_env"],
        AGENT_CONFIG["alpaca_url_env"],
    )


# ── Late binding for the candidate universe ───────────────────────────────
# screener_core imports config in some paths; set the universe pointer after the
# dict is built (same one-directional-import pattern config.py uses for
# SM_CURATED_UNIVERSE). This account only borrows the universe as a starting
# candidate pool — it runs none of the screener/wheel machinery.
from screener_core import SM_CURATED_UNIVERSE as _SM_CURATED_UNIVERSE
AGENT_CONFIG["universe"] = list(_SM_CURATED_UNIVERSE)
