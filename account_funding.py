"""Live-account funding (deposit/withdrawal) detection.

Reads Alpaca's /v2/account/activities for CSD (cash deposit) and CSW (cash
withdrawal) records — the authoritative cash-transfer log — and announces any
NEW transfer to the mode's Discord trades channel (green deposit / red
withdrawal). This is the only reliable signal: equity and cash both move from
ordinary trading P&L, so an equity-diff would miss small deposits or fire false
alarms. CSD/CSW records appear only for real transfers.

Scope: live (real money). Mode-parameterized, so wiring a paper mode later is a
one-line workflow change — but only live is wired today.

Fully fail-soft: check_funding swallows every error (logs to the mode's errors
channel) and main() always exits 0, so a funding hiccup can never disrupt a
trading cycle. Runs as a continue-on-error step in tsla-monitor-live.yml.

State: account_state_<mode>.json holds the ids already announced (committed back
to the repo so a fresh Actions checkout remembers them). The FIRST run (no state
file) seeds every current CSD/CSW id and announces NOTHING, so historical/initial
funding never pings retroactively — only transfers appearing AFTER the first run
are announced.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

import config
from alpaca_data import get_account, get_account_activities
from notifications import send_embed, Color

load_dotenv()

ROOT = Path(__file__).resolve().parent

# Lookback window for each cycle's fetch. Older transfers are already seeded or
# announced; this only needs to cover the gap since the last run.
LOOKBACK_DAYS = 90
# Bound the stored seen-id list. At a handful of transfers a year this never
# drops an id still inside the LOOKBACK_DAYS fetch window.
MAX_SEEN_IDS = 1000

# Statuses that are NOT a real, completed transfer — skip them.
_DEAD_STATUSES = {"canceled", "cancelled", "rejected", "failed"}


def _state_path(mode: str) -> Path:
    return ROOT / f"account_state_{mode}.json"


def _load_seen(path: Path) -> list[str]:
    try:
        with open(path) as f:
            data = json.load(f)
        return [str(i) for i in data.get("seen_activity_ids", []) if i]
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def _save_seen(path: Path, seen_ids: list[str]) -> None:
    payload = {
        "seen_activity_ids": seen_ids[-MAX_SEEN_IDS:],
        "last_checked": datetime.now(timezone.utc).isoformat(),
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


def classify_activity(act: dict) -> tuple[str | None, float]:
    """Map a raw activity dict to (kind, amount).

    kind is "deposit" (CSD), "withdrawal" (CSW), or None (any other type, or a
    canceled/rejected transfer). amount is always a positive dollar figure;
    direction lives in `kind`, not the sign of net_amount.
    """
    if str(act.get("status", "")).lower() in _DEAD_STATUSES:
        return None, 0.0
    try:
        amount = abs(float(act.get("net_amount", 0) or 0))
    except (TypeError, ValueError):
        return None, 0.0
    atype = act.get("activity_type")
    if atype == "CSD":
        return "deposit", amount
    if atype == "CSW":
        return "withdrawal", amount
    return None, 0.0


def _announce(kind, amount, act, account, trades_ch, actions_ch, mode):
    is_deposit = kind == "deposit"
    emoji = "💰" if is_deposit else "💸"
    sign = "+" if is_deposit else "−"
    color = Color.GREEN if is_deposit else Color.RED
    word = "Deposit" if is_deposit else "Withdrawal"

    fields = [{"name": "Amount", "value": f"{sign}${amount:,.2f}", "inline": True}]
    cash = account.get("cash")
    equity = account.get("equity", account.get("portfolio_value"))
    if cash is not None:
        try:
            fields.append({"name": "New cash", "value": f"${float(cash):,.2f}", "inline": True})
        except (TypeError, ValueError):
            pass
    if equity is not None:
        try:
            fields.append({"name": "New equity", "value": f"${float(equity):,.2f}", "inline": True})
        except (TypeError, ValueError):
            pass
    if act.get("date"):
        fields.append({"name": "Date", "value": str(act["date"]), "inline": True})

    send_embed(
        trades_ch,
        f"{emoji} {word} detected: {sign}${amount:,.2f}",
        color=color,
        fields=fields,
        footer=f"account_funding.py · {mode}",
        actions_channel=actions_ch,
    )


def check_funding(mode: str) -> None:
    """Detect and announce new deposits/withdrawals for `mode`. Fail-soft."""
    # Safe channel defaults so the except can always report — even if the config
    # lookup itself is what failed (e.g. an unknown mode). The Discord channel
    # convention is "<mode>_<domain>", and send_embed no-ops on an unmapped
    # channel, so a bogus mode degrades to a harmless log instead of a raise.
    errors_ch = f"{mode}_errors"
    actions_ch = f"{mode}_actions"
    try:
        cfg = config.get_mode(mode)
        trades_ch = cfg["trades_channel"]
        actions_ch = cfg["actions_channel"]
        errors_ch = cfg["errors_channel"]
        path = _state_path(mode)

        after = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).isoformat()
        activities = get_account_activities(mode, ["CSD", "CSW"], after=after) or []

        first_run = not path.exists()
        seen = _load_seen(path)
        seen_set = set(seen)
        new_acts = [a for a in activities if a.get("id") and a["id"] not in seen_set]

        if first_run:
            for a in activities:
                if a.get("id") and a["id"] not in seen_set:
                    seen.append(a["id"])
                    seen_set.add(a["id"])
            _save_seen(path, seen)
            return

        if new_acts:
            try:
                account = get_account(mode)
            except Exception:
                account = {}  # balance context is optional; never block the ping
            for a in sorted(new_acts, key=lambda x: str(x.get("date", ""))):
                kind, amount = classify_activity(a)
                if kind is not None:
                    _announce(kind, amount, a, account, trades_ch, actions_ch, mode)
                seen.append(a["id"])
                seen_set.add(a["id"])

        _save_seen(path, seen)

    except Exception as e:
        send_embed(
            errors_ch,
            f"account_funding.py error ({mode})",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:400]}`",
            footer=f"account_funding.py · {mode}",
            actions_channel=actions_ch,
        )


def main() -> None:
    mode, _ = config.parse_mode_arg(sys.argv[1:])
    check_funding(mode)


if __name__ == "__main__":
    main()
