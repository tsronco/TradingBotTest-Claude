"""Shared pytest fixtures for project-root tests.

Auto-clears Discord webhook env vars and Alpaca credentials so tests
never hit real services. The notifications package no-ops when its
webhook env vars are absent, so this prevents accidental message floods.
"""
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def _silence_discord_and_alpaca(monkeypatch, tmp_path):
    """Strip out webhook + Alpaca env vars and redirect JSONL logs to tmp.

    - notifications.discord no-ops when its webhook env is unset.
    - notifications.jsonl_log writes to BOT_LOG_DIR (default "logs") — we
      point it at a tmp dir so test runs don't pollute the real logs/.
    - Alpaca env vars are set to fake values so any code path that reads
      them gets safe placeholders instead of real secrets.
    """
    # ALL Discord webhook env vars must be cleared — manual + live — so a test
    # that calls `apply_mode("manual")` (or live) doesn't accidentally fire a
    # real Discord embed via `send_embed(TRADES_CH, ...)`. Caught on 2026-05-14:
    # test_manual_mode.py was spamming real #manual-trades because the webhooks
    # weren't cleared here.
    for var in (
        # Manual
        "DISCORD_MANUAL_TRADES_WEBHOOK",
        "DISCORD_MANUAL_SUMMARY_WEBHOOK",
        "DISCORD_MANUAL_ERRORS_WEBHOOK",
        "DISCORD_MANUAL_ACTIONS_WEBHOOK",
        # Live
        "DISCORD_LIVE_TRADES_WEBHOOK",
        "DISCORD_LIVE_SUMMARY_WEBHOOK",
        "DISCORD_LIVE_ERRORS_WEBHOOK",
        "DISCORD_LIVE_ACTIONS_WEBHOOK",
    ):
        monkeypatch.delenv(var, raising=False)
    # All Alpaca creds get fake values so a missed monkeypatch can't reach
    # the real paper or live endpoints.
    monkeypatch.setenv("ALPACA_MANUAL_API_KEY", "fake-manual-key")
    monkeypatch.setenv("ALPACA_MANUAL_API_SECRET", "fake-manual-secret")
    monkeypatch.setenv("ALPACA_MANUAL_BASE_URL", "https://paper-api.alpaca.markets/v2")
    monkeypatch.setenv("ALPACA_LIVE_API_KEY", "fake-live-key")
    monkeypatch.setenv("ALPACA_LIVE_API_SECRET", "fake-live-secret")
    monkeypatch.setenv("ALPACA_LIVE_BASE_URL", "https://api.alpaca.markets/v2")
    monkeypatch.setenv("BOT_LOG_DIR", str(tmp_path / "logs"))
    # The jsonl_log module reads BOT_LOG_DIR at import time. Force a re-read
    # so this monkeypatch actually affects new log_event calls in tests.
    import notifications.jsonl_log as jsonl_mod
    monkeypatch.setattr(jsonl_mod, "LOG_DIR", tmp_path / "logs")


@pytest.fixture
def fresh_symbol_state():
    """Returns a brand-new per-symbol wheel state dict (stage 1, no contract)."""
    import wheel_strategy
    return wheel_strategy._empty_symbol_state()


@pytest.fixture
def alpaca_account_state():
    """Mutable account dict that mocked get_account() returns each call.

    Tests that exercise BP-constrained paths (insufficient_bp, decrement,
    consecutive sales) modify this dict before calling the wheel, so the
    re-fetch inside _sell_new_put sees the right BP. Tests that don't
    care about BP just leave it at the high default.
    """
    return {
        "cash": "100000",
        "options_buying_power": "100000",
        "portfolio_value": "100000",
    }


@pytest.fixture(autouse=True)
def _mock_wheel_get_account(monkeypatch, alpaca_account_state):
    """Stub wheel_strategy.get_account() globally so tests don't hit Alpaca.

    The 2026-05-01 fix to _sell_new_put added an in-function get_account()
    call (re-fetching BP on every order check, since Alpaca reserves more
    than `strike × 100` for pending CSPs and our local snapshot drifted
    optimistic). Without this mock, tests would either hit live Alpaca or
    fail on missing creds.
    """
    import wheel_strategy as ws
    monkeypatch.setattr(ws, "get_account", lambda: alpaca_account_state, raising=False)
