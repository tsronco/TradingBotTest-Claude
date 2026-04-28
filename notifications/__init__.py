"""Shared notification + logging helpers for trading bots.

Two public modules:
  - discord: send rich embeds to per-domain Discord channels
  - jsonl_log: append structured events to logs/*.jsonl

Both are no-ops when their environment variables are not set, so local runs
without webhooks/log dirs don't break.
"""
from notifications.discord import (
    Color,
    send_embed,
    send_text,
)
from notifications.jsonl_log import log_event

__all__ = ["Color", "send_embed", "send_text", "log_event"]
