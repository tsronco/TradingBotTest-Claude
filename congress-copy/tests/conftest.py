"""Shared pytest fixtures."""
import os
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def tmp_db(tmp_path: Path) -> str:
    """Path to a fresh SQLite database that lives only for the test."""
    return str(tmp_path / "state.db")


@pytest.fixture
def paper_env(monkeypatch):
    """Set env vars to valid paper-trading values."""
    monkeypatch.setenv("ALPACA_API_KEY", "fake_paper_key")
    monkeypatch.setenv("ALPACA_API_SECRET", "fake_paper_secret")
    monkeypatch.setenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets/v2")


@pytest.fixture
def live_env(monkeypatch):
    """Set env vars to a LIVE (forbidden) URL — guard must block this."""
    monkeypatch.setenv("ALPACA_API_KEY", "fake_live_key")
    monkeypatch.setenv("ALPACA_API_SECRET", "fake_live_secret")
    monkeypatch.setenv("ALPACA_BASE_URL", "https://api.alpaca.markets/v2")
