"""R33 — live (real-money) mode must refuse to run against the paper endpoint.

A missing/malformed ALPACA_LIVE_BASE_URL used to silently fall back to the
paper endpoint, so the live script would 'trade' paper while the real-money
account went unmanaged. apply_mode now hard-fails for live in that case.
Covers both order-placing scripts (long_options_strategy delegates to
wheel_strategy.apply_mode, so it's covered transitively).
"""
import pytest

import config
import strategy as strat
import wheel_strategy as ws


@pytest.fixture(autouse=True)
def _restore_modes():
    yield
    strat.apply_mode(config.DEFAULT_MODE)
    ws.apply_mode(config.DEFAULT_MODE)


@pytest.mark.parametrize("mod", [ws, strat])
def test_live_with_proper_endpoint_ok(mod, monkeypatch):
    monkeypatch.setenv("ALPACA_LIVE_BASE_URL", "https://api.alpaca.markets/v2")
    mod.apply_mode("live")  # must not raise
    assert "paper-api" not in mod.BASE_URL
    assert "api.alpaca.markets" in mod.BASE_URL


@pytest.mark.parametrize("mod", [ws, strat])
def test_live_with_paper_endpoint_refuses(mod, monkeypatch):
    monkeypatch.setenv("ALPACA_LIVE_BASE_URL", "https://paper-api.alpaca.markets/v2")
    with pytest.raises(RuntimeError, match="PAPER endpoint"):
        mod.apply_mode("live")


@pytest.mark.parametrize("mod", [ws, strat])
def test_live_with_missing_endpoint_refuses(mod, monkeypatch):
    monkeypatch.delenv("ALPACA_LIVE_BASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="PAPER endpoint"):
        mod.apply_mode("live")


@pytest.mark.parametrize("mod", [ws, strat])
def test_live_with_placeholder_endpoint_refuses(mod, monkeypatch):
    monkeypatch.setenv("ALPACA_LIVE_BASE_URL", "-")  # malformed placeholder
    with pytest.raises(RuntimeError, match="PAPER endpoint"):
        mod.apply_mode("live")


@pytest.mark.parametrize("mod", [ws, strat])
def test_paper_modes_unaffected(mod, monkeypatch):
    mod.apply_mode("manual")
    assert "paper-api" in mod.BASE_URL  # non-live modes still resolve to paper
