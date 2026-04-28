"""Discord webhook notifications.

Routes messages to one of several per-domain channels by name:
  - "tsla"     → DISCORD_TSLA_WEBHOOK     (#tsla-trades)
  - "congress" → DISCORD_CONGRESS_WEBHOOK (#congress-trades)
  - "summary"  → DISCORD_SUMMARY_WEBHOOK  (#daily-summary)
  - "errors"   → DISCORD_ERRORS_WEBHOOK   (#errors)
  - "actions"  → DISCORD_ACTIONS_WEBHOOK  (#all-actions, optional firehose)

If the webhook env var for a channel is unset, the call becomes a no-op so
local dev runs don't fail. Errors talking to Discord are swallowed (logged
to stderr) so a flaky webhook never breaks a trading bot.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Optional

CHANNEL_ENV_MAP = {
    "tsla":     "DISCORD_TSLA_WEBHOOK",
    "congress": "DISCORD_CONGRESS_WEBHOOK",
    "summary":  "DISCORD_SUMMARY_WEBHOOK",
    "errors":   "DISCORD_ERRORS_WEBHOOK",
    "actions":  "DISCORD_ACTIONS_WEBHOOK",
}


class Color:
    GREEN  = 0x2ECC71  # profit, successful sell, fill
    RED    = 0xE74C3C  # loss, stop-out, error
    YELLOW = 0xF1C40F  # pending, order placed, warning
    BLUE   = 0x3498DB  # informational, heartbeat, no-op cycle


def _webhook_url(channel: str) -> Optional[str]:
    env_var = CHANNEL_ENV_MAP.get(channel)
    if env_var is None:
        return None
    return os.getenv(env_var)


def _post(url: str, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "TradingBotTest-Claude (https://github.com/tsronco)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 400:
                print(
                    f"[discord] webhook returned {resp.status}: {resp.read()[:200]!r}",
                    file=sys.stderr,
                )
    except urllib.error.HTTPError as e:
        print(f"[discord] webhook HTTP {e.code}: {e.read()[:200]!r}", file=sys.stderr)
    except Exception as e:
        print(f"[discord] webhook post failed: {e}", file=sys.stderr)


def send_text(channel: str, message: str, also_to_actions: bool = True) -> None:
    """Send a plain text message to a channel.

    If also_to_actions is True (default), also mirror to the firehose
    #all-actions channel for one-scroll review.
    """
    url = _webhook_url(channel)
    if url:
        _post(url, {"content": message})

    if also_to_actions and channel != "actions":
        actions_url = _webhook_url("actions")
        if actions_url:
            _post(actions_url, {"content": f"[{channel}] {message}"})


def send_embed(
    channel: str,
    title: str,
    color: int = Color.BLUE,
    description: Optional[str] = None,
    fields: Optional[list[dict]] = None,
    footer: Optional[str] = None,
    also_to_actions: bool = True,
) -> None:
    """Send a Discord embed (colored card) to a channel.

    fields: list of {"name": str, "value": str, "inline": bool}
    """
    embed = {
        "title": title,
        "color": color,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if description:
        embed["description"] = description
    if fields:
        embed["fields"] = fields
    if footer:
        embed["footer"] = {"text": footer}

    payload = {"embeds": [embed]}

    url = _webhook_url(channel)
    if url:
        _post(url, payload)

    if also_to_actions and channel != "actions":
        actions_url = _webhook_url("actions")
        if actions_url:
            mirrored = dict(embed)
            mirrored["title"] = f"[{channel}] {title}"
            _post(actions_url, {"embeds": [mirrored]})
