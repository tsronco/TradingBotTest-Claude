"""Create the Discord channels + webhooks for the chosen accounts.

Needs a bot token (bot invited to the server with Manage Channels + Manage
Webhooks) and the server (guild) ID. Idempotent: an existing channel of the
same name is reused; an existing installer-made webhook is reused rather than
piling up duplicates.
"""
from __future__ import annotations

import time

import requests

API = "https://discord.com/api/v10"
WEBHOOK_NAME = "tradingbot"


class DiscordError(RuntimeError):
    pass


class DiscordSetup:
    def __init__(self, bot_token: str, guild_id: str, *, dry_run: bool = False):
        self.guild_id = str(guild_id).strip()
        self.dry_run = dry_run
        self._headers = {
            "Authorization": f"Bot {bot_token}",
            "Content-Type": "application/json",
        }
        self._channels: dict[str, str] | None = None  # name -> id

    def _request(self, method: str, path: str, json: dict | None = None) -> dict | list:
        for attempt in range(5):
            r = requests.request(method, f"{API}{path}", headers=self._headers, json=json, timeout=20)
            if r.status_code == 429:
                wait = float(r.headers.get("Retry-After", r.json().get("retry_after", 2)))
                time.sleep(min(wait, 10) + 0.5)
                continue
            if r.status_code in (401, 403):
                raise DiscordError(
                    "Discord rejected the bot token / permissions. The bot must "
                    "be in the server with Manage Channels + Manage Webhooks."
                )
            if r.status_code >= 400:
                raise DiscordError(f"{method} {path} -> HTTP {r.status_code}: {r.text[:200]}")
            return r.json() if r.content else {}
        raise DiscordError(f"{method} {path} kept hitting rate limits")

    def _load_channels(self) -> dict[str, str]:
        if self._channels is None:
            chans = self._request("GET", f"/guilds/{self.guild_id}/channels")
            self._channels = {c["name"]: c["id"] for c in chans if c.get("type") == 0}
        return self._channels

    def _ensure_channel(self, name: str) -> str:
        existing = self._load_channels()
        if name in existing:
            return existing[name]
        if self.dry_run:
            return f"dry-run-{name}"
        created = self._request(
            "POST", f"/guilds/{self.guild_id}/channels", {"name": name, "type": 0}
        )
        self._channels[name] = created["id"]  # type: ignore[index]
        return created["id"]  # type: ignore[index,return-value]

    def _ensure_webhook(self, channel_id: str, channel_name: str) -> str:
        if self.dry_run:
            return f"https://discord.com/api/webhooks/DRYRUN/{channel_name}"
        hooks = self._request("GET", f"/channels/{channel_id}/webhooks")
        for h in hooks:  # reuse one we made before
            if h.get("name") == WEBHOOK_NAME and h.get("token"):
                return f"https://discord.com/api/webhooks/{h['id']}/{h['token']}"
        created = self._request(
            "POST", f"/channels/{channel_id}/webhooks", {"name": WEBHOOK_NAME}
        )
        return f"https://discord.com/api/webhooks/{created['id']}/{created['token']}"

    def ensure(self, channel_name: str) -> str:
        """Channel + webhook for ``channel_name``; returns the webhook URL."""
        cid = self._ensure_channel(channel_name)
        return self._ensure_webhook(cid, channel_name)
