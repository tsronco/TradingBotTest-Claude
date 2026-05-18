"""Single source of truth for the installer's account/credential model.

Everything here is **derived from the bot's own `config.MODES` and
`notifications.discord.CHANNEL_ENV_MAP`** rather than re-listed, so the
installer can never drift from what the bot actually reads at runtime.
``tests/test_installer_spec.py`` asserts that derivation stays consistent.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import config  # noqa: E402
from notifications.discord import CHANNEL_ENV_MAP  # noqa: E402

# Recommended setup order — conservative first (the minimal path), live last.
ACCOUNT_ORDER = [
    "conservative",
    "aggressive",
    "manual",
    "sm500",
    "sm1000",
    "sm2000",
    "live",
]

PAPER_URL = "https://paper-api.alpaca.markets/v2"
LIVE_URL = "https://api.alpaca.markets/v2"

# Human-facing labels (the channel *names* a forker creates in Discord are
# arbitrary — only the webhook URL matters — but suggesting consistent names
# keeps the server tidy and matches CLAUDE.md / instructions.md).
_PREFIX = {
    "conservative": None,  # conservative channels are unprefixed
    "aggressive": "aggressive",
    "manual": "manual",
    "live": "live",
    "sm500": "sm500",
    "sm1000": "sm1000",
    "sm2000": "sm2000",
}
# role -> (unprefixed conservative name, suffix used for prefixed accounts)
_ROLE_NAME = {
    "trades_channel": ("trades", "trades"),
    "summary_channel": ("daily-summary", "summary"),
    "errors_channel": ("errors", "errors"),
    "actions_channel": ("all-actions", "actions"),
}
_ROLE_ORDER = ["trades_channel", "summary_channel", "errors_channel", "actions_channel"]

CONGRESS_WEBHOOK_ENV = CHANNEL_ENV_MAP["congress"]
CONGRESS_CHANNEL_NAME = "congress-trades"


@dataclass(frozen=True)
class Account:
    mode: str
    label: str
    is_real: bool
    default_url: str
    key_env: str
    secret_env: str
    url_env: str
    # webhook_env -> suggested Discord channel display name
    webhooks: dict[str, str] = field(default_factory=dict)

    @property
    def alpaca_env(self) -> list[str]:
        return [self.key_env, self.secret_env, self.url_env]


_LABELS = {
    "conservative": "Conservative paper (auto wheel, 10% OTM)",
    "aggressive": "Aggressive paper (5% OTM, +crypto)",
    "manual": "Manual paper (you open, bot manages)",
    "live": "LIVE — REAL MONEY (manage-only)",
    "sm500": "Small $500 paper (auto credit spreads)",
    "sm1000": "Small $1,000 paper (auto credit spreads)",
    "sm2000": "Small $2,000 paper (auto credit spreads)",
}


def _channel_display(mode: str, role: str) -> str:
    prefix = _PREFIX[mode]
    unprefixed, suffix = _ROLE_NAME[role]
    return unprefixed if prefix is None else f"{prefix}-{suffix}"


def account(mode: str) -> Account:
    """Build the Account model for one mode straight from config.MODES."""
    m = config.MODES[mode]
    is_real = mode == "live"
    webhooks: dict[str, str] = {}
    for role in _ROLE_ORDER:
        channel_key = m[role]
        env = CHANNEL_ENV_MAP[channel_key]
        webhooks[env] = _channel_display(mode, role)
    if mode == "conservative":
        webhooks[CONGRESS_WEBHOOK_ENV] = CONGRESS_CHANNEL_NAME
    return Account(
        mode=mode,
        label=_LABELS[mode],
        is_real=is_real,
        default_url=LIVE_URL if is_real else PAPER_URL,
        key_env=m["alpaca_key_env"],
        secret_env=m["alpaca_secret_env"],
        url_env=m["alpaca_url_env"],
        webhooks=webhooks,
    )


def all_accounts() -> list[Account]:
    return [account(m) for m in ACCOUNT_ORDER]


# ── Non-account ("global") secrets ────────────────────────────────────────
# kind:
#   "ask"       — user pastes a value the installer cannot generate
#   "generate"  — installer can mint a random value (offered, user may paste)
GLOBAL_SECRETS = [
    ("GITHUB_ACCESS_TOKEN", "ask", "Fine-grained GitHub PAT (Contents+Actions+Workflows+Administration+Secrets: read/write)"),
    ("CRONJOB_API_KEY", "ask", "cron-job.org API key (Settings -> API)"),
    ("UPSTASH_EMAIL", "ask", "Upstash account email (provisions the dashboard's Redis)"),
    ("UPSTASH_API_KEY", "ask", "Upstash Management API key (console -> Account -> Management API)"),
    ("BOT_PUSH_TOKEN", "generate", "Shared secret: bot -> dashboard /api/bot-state"),
    ("DASHBOARD_CRON_TOKEN", "generate", "Mirrors Vercel CRON_TOKEN (trade-grading cron)"),
]

# Dashboard-only env (written to dashboard/.env and pushed to Vercel).
# "alpaca" entries are filled from the selected accounts, not asked again.
DASHBOARD_SECRETS = [
    ("DASHBOARD_PASSWORD", "generate", "Password you type to log in (choose your own or generate)"),
    ("SESSION_SECRET", "generate", "Signs the login cookie"),
    ("INTERNAL_FUNCTIONS_TOKEN", "generate", "Gate between dashboard TS proxy and Python fn"),
    ("CRON_TOKEN", "generate", "Bearer for /api/cron/* (mirror of DASHBOARD_CRON_TOKEN)"),
    ("BOT_PUSH_TOKEN", "generate", "Same value as the bot-side BOT_PUSH_TOKEN"),
    ("TOTP_SECRET", "totp", "Base32 TOTP secret for the authenticator app"),
    ("BACKUP_CODES_HASHED", "backup", "Hashed single-use backup codes"),
    ("ANTHROPIC_API_KEY", "ask", "Anthropic API key (sk-ant-...) for AI trade grading"),
]


def github_secret_envs(modes: list[str], include_congress: bool) -> list[str]:
    """Repo Actions secrets the bot workflows need for the chosen accounts.

    Alpaca trio + Discord webhooks per account, plus the shared BOT_PUSH_TOKEN.
    GITHUB_ACCESS_TOKEN / CRONJOB_API_KEY are NOT repo secrets — cron-job.org
    holds the PAT itself and setup_cronjobs.py runs locally.
    """
    out: list[str] = []
    for mode in modes:
        acc = account(mode)
        out.extend(acc.alpaca_env)
        for env in acc.webhooks:
            if env == CONGRESS_WEBHOOK_ENV and not include_congress:
                continue
            out.append(env)
    out.append("BOT_PUSH_TOKEN")
    # de-dup, preserve order
    seen: set[str] = set()
    return [e for e in out if not (e in seen or seen.add(e))]


def dashboard_env_keys(modes: list[str]) -> list[str]:
    """Every key dashboard/.env + Vercel needs for the chosen accounts."""
    keys = [k for k, _, _ in DASHBOARD_SECRETS]
    for mode in modes:
        if mode == "live":
            continue  # dashboard live trading stays disabled by default
        keys.extend(account(mode).alpaca_env)
    keys.append("ALPACA_DATA_BASE_URL")
    seen: set[str] = set()
    return [k for k in keys if not (k in seen or seen.add(k))]
