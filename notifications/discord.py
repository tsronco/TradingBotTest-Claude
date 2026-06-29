"""Discord webhook notifications.

Routes messages to one of several per-domain channels by name. Each account
uses its own parallel set so the modes never cross-pollinate.

Manual:
  - "manual_trades"  → DISCORD_MANUAL_TRADES_WEBHOOK   (#manual-trades)
  - "manual_summary" → DISCORD_MANUAL_SUMMARY_WEBHOOK  (#manual-summary)
  - "manual_errors"  → DISCORD_MANUAL_ERRORS_WEBHOOK   (#manual-errors)
  - "manual_actions" → DISCORD_MANUAL_ACTIONS_WEBHOOK  (#manual-actions, firehose)

Live (REAL MONEY):
  - "live_trades"  → DISCORD_LIVE_TRADES_WEBHOOK   (#live-trades)
  - "live_summary" → DISCORD_LIVE_SUMMARY_WEBHOOK  (#live-summary)
  - "live_errors"  → DISCORD_LIVE_ERRORS_WEBHOOK   (#live-errors)
  - "live_actions" → DISCORD_LIVE_ACTIONS_WEBHOOK  (#live-actions, firehose)

(The conservative, aggressive, and sm500/sm1000/sm2000 channel sets were
retired 2026-06-29 along with those accounts.)

If the webhook env var for a channel is unset, the call becomes a no-op so
local dev runs don't fail. Errors talking to Discord are swallowed (logged
to stderr) so a flaky webhook never breaks a trading bot.

The send_embed/send_text functions accept `actions_channel` to specify which
firehose channel to mirror to. Each mode passes its own actions channel name
(e.g. "manual_actions", "live_actions"); an unmapped channel is a safe no-op.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Optional

# Status codes worth retrying. Everything in here is "Discord (or its edge)
# is having a bad moment" rather than "the request itself is malformed":
#   429 — rate limited (we should also honor Retry-After, but the simple
#         fixed backoff below is good enough for our low post volume)
#   500/502/503/504 — Discord's load balancer or upstream is temporarily down
# 4xx codes are NOT retried — those mean the webhook URL is wrong or the
# payload is invalid, and retrying won't help.
_RETRY_STATUS_CODES = {429, 500, 502, 503, 504}

# Backoff in seconds between attempts. With 3 attempts total this is
# attempt-1 → 2s → attempt-2 → 8s → attempt-3 (max ~10s extra per call).
# Keeps the bound tight enough that a wheel cycle posting 6–7 embeds
# during a real Discord outage still finishes well inside the GitHub
# Actions step timeout.
_RETRY_BACKOFFS = (2, 8)
_MAX_ATTEMPTS = 3

CHANNEL_ENV_MAP = {
    "manual_trades":  "DISCORD_MANUAL_TRADES_WEBHOOK",
    "manual_summary": "DISCORD_MANUAL_SUMMARY_WEBHOOK",
    "manual_errors":  "DISCORD_MANUAL_ERRORS_WEBHOOK",
    "manual_actions": "DISCORD_MANUAL_ACTIONS_WEBHOOK",
    "live_trades":    "DISCORD_LIVE_TRADES_WEBHOOK",
    "live_summary":   "DISCORD_LIVE_SUMMARY_WEBHOOK",
    "live_errors":    "DISCORD_LIVE_ERRORS_WEBHOOK",
    "live_actions":   "DISCORD_LIVE_ACTIONS_WEBHOOK",
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
    """POST a JSON payload to a Discord webhook with bounded retry.

    Discord's edge occasionally returns 503 ("upstream connect error /
    overflow") during incidents — we observed today's daily summary lose
    every embed to this. The retry loop makes us robust to transient
    blips without changing the fail-soft contract for permanent errors:
    a 4xx (bad webhook URL, oversized payload) still fails fast, just
    with a stderr log; an unrecoverable 5xx after _MAX_ATTEMPTS does
    the same. The function never raises.
    """
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

    for attempt in range(_MAX_ATTEMPTS):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                # Discord normally returns 204 on a successful webhook post.
                # Anything 4xx here is unusual but possible (some proxies turn
                # HTTPError statuses into normal responses). Don't retry on
                # 4xx — it's a bad request, not a transient blip.
                if resp.status >= 400:
                    print(
                        f"[discord] webhook returned {resp.status}: {resp.read()[:200]!r}",
                        file=sys.stderr,
                    )
                return  # done — success or terminal 4xx

        except urllib.error.HTTPError as e:
            # Status-coded failure from Discord. Retry only on the codes that
            # represent "try again soon"; bail on anything else.
            if e.code in _RETRY_STATUS_CODES and attempt + 1 < _MAX_ATTEMPTS:
                wait = _RETRY_BACKOFFS[attempt]
                print(
                    f"[discord] webhook HTTP {e.code} (attempt {attempt+1}/{_MAX_ATTEMPTS}); retrying in {wait}s",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            # Out of retries, OR a non-retryable code (4xx).
            print(f"[discord] webhook HTTP {e.code}: {e.read()[:200]!r}", file=sys.stderr)
            return

        except (urllib.error.URLError, OSError) as e:
            # Connection-level failure (DNS, TCP reset, timeout). These are
            # almost always transient — retry. Includes socket.timeout (which
            # is an OSError subclass on Python 3.10+).
            if attempt + 1 < _MAX_ATTEMPTS:
                wait = _RETRY_BACKOFFS[attempt]
                print(
                    f"[discord] connection error (attempt {attempt+1}/{_MAX_ATTEMPTS}, retrying in {wait}s): {e}",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            print(f"[discord] webhook post failed after {_MAX_ATTEMPTS} attempts: {e}", file=sys.stderr)
            return

        except Exception as e:
            # Truly unexpected — log and bail without retry.
            print(f"[discord] webhook post failed: {e}", file=sys.stderr)
            return


def send_text(
    channel: str,
    message: str,
    also_to_actions: bool = True,
    actions_channel: str = "actions",
) -> None:
    """Send a plain text message to a channel.

    If also_to_actions is True (default), also mirror to the firehose
    actions_channel (each mode passes its own, e.g. "manual_actions").
    """
    url = _webhook_url(channel)
    if url:
        _post(url, {"content": message})

    if also_to_actions and channel != actions_channel:
        actions_url = _webhook_url(actions_channel)
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
    actions_channel: str = "actions",
) -> None:
    """Send a Discord embed (colored card) to a channel.

    fields: list of {"name": str, "value": str, "inline": bool}

    If also_to_actions is True (default), mirrors to actions_channel
    (each mode passes its own, e.g. "manual_actions").
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

    if also_to_actions and channel != actions_channel:
        actions_url = _webhook_url(actions_channel)
        if actions_url:
            mirrored = dict(embed)
            mirrored["title"] = f"[{channel}] {title}"
            _post(actions_url, {"embeds": [mirrored]})
