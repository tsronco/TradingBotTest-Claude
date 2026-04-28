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
def _silence_discord_and_alpaca(monkeypatch):
    """Strip out webhook + Alpaca env vars for the duration of every test.

    notifications.discord no-ops when its webhook env is unset, and the
    wheel API helpers should always be mocked, never hit real Alpaca.
    """
    for var in (
        "DISCORD_TSLA_WEBHOOK",
        "DISCORD_CONGRESS_WEBHOOK",
        "DISCORD_SUMMARY_WEBHOOK",
        "DISCORD_ERRORS_WEBHOOK",
        "DISCORD_ACTIONS_WEBHOOK",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("ALPACA_API_KEY", "fake-test-key")
    monkeypatch.setenv("ALPACA_API_SECRET", "fake-test-secret")
    monkeypatch.setenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets/v2")


@pytest.fixture
def fresh_symbol_state():
    """Returns a brand-new per-symbol wheel state dict (stage 1, no contract)."""
    import wheel_strategy
    return wheel_strategy._empty_symbol_state()
