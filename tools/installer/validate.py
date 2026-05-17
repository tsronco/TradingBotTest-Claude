"""Lightweight live credential checks.

Used inline after a user pastes a key (catch typos immediately) and again in
the final health pass. All read-only / harmless: an Alpaca account GET and an
optional Discord webhook test message.
"""
from __future__ import annotations

import requests


def check_alpaca(key: str, secret: str, base_url: str) -> tuple[bool, str]:
    """GET <base_url>/account. True iff Alpaca accepts the credentials."""
    base = base_url.rstrip("/")
    try:
        r = requests.get(
            f"{base}/account",
            headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
            timeout=20,
        )
    except requests.RequestException as e:
        return False, f"network error: {e}"
    if r.status_code == 200:
        data = r.json()
        status = data.get("status", "?")
        equity = data.get("equity", "?")
        return True, f"OK (status={status}, equity={equity})"
    if r.status_code in (401, 403):
        return False, "rejected — wrong key/secret, or paper key used on the live endpoint"
    return False, f"HTTP {r.status_code}: {r.text[:160]}"


def check_discord(webhook_url: str, message: str = "✅ setup.py: webhook wired") -> tuple[bool, str]:
    if not webhook_url.startswith("https://discord.com/api/webhooks/"):
        return False, "not a Discord webhook URL"
    try:
        r = requests.post(webhook_url, json={"content": message}, timeout=20)
    except requests.RequestException as e:
        return False, f"network error: {e}"
    if r.status_code in (200, 204):
        return True, "OK (test message posted)"
    return False, f"HTTP {r.status_code}: {r.text[:160]}"
