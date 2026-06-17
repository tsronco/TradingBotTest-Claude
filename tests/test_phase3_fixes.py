"""Phase 3 money-loss remediation fixes (R17, R34, ...)."""
import pytest

import config
import wheel_strategy as ws


def _raise(*a, **k):
    raise RuntimeError("trades endpoint down")


# ── R17: last-price fallback divides combined market_value by 100 × qty ──────

def test_last_price_fallback_divides_by_contract_count(monkeypatch):
    monkeypatch.setattr(ws, "_alpaca_request", _raise)
    monkeypatch.setattr(ws, "get_option_position",
                        lambda c: {"market_value": "-80", "qty": "-4"})
    # 4 contracts, combined value $80 → per-contract $0.20 (was $0.80 pre-fix)
    assert ws.get_option_last_price("X") == pytest.approx(0.20)


def test_last_price_fallback_single_contract(monkeypatch):
    monkeypatch.setattr(ws, "_alpaca_request", _raise)
    monkeypatch.setattr(ws, "get_option_position",
                        lambda c: {"market_value": "-30", "qty": "-1"})
    assert ws.get_option_last_price("X") == pytest.approx(0.30)


def test_last_price_fallback_missing_qty_defaults_to_one(monkeypatch):
    monkeypatch.setattr(ws, "_alpaca_request", _raise)
    monkeypatch.setattr(ws, "get_option_position",
                        lambda c: {"market_value": "-30"})  # no qty field
    assert ws.get_option_last_price("X") == pytest.approx(0.30)


# ── R34: place_buy_to_close concession is a % of price, not a flat $0.05 ──────

@pytest.fixture
def manual_mode():
    ws.apply_mode("manual")
    yield
    ws.apply_mode(config.DEFAULT_MODE)


def test_btc_limit_cheap_option_small_concession(monkeypatch, manual_mode):
    captured = {}
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: captured.update(body) or {"id": "o"})
    monkeypatch.setattr(ws, "get_option_position", lambda c: {"qty": "-1"})
    # Cheap option at $0.05 — flat +$0.05 would DOUBLE it to $0.10. The % concession
    # adds at most ~5% (rounded, floored at 1¢) → $0.06.
    ws.place_buy_to_close("X260101P00010000", 0.05)
    assert float(captured["limit_price"]) <= 0.07


def test_btc_limit_normal_option_still_marketable(monkeypatch, manual_mode):
    captured = {}
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: captured.update(body) or {"id": "o"})
    monkeypatch.setattr(ws, "get_option_position", lambda c: {"qty": "-1"})
    # A $1.00 option still gets a small upward nudge to ensure a fill.
    ws.place_buy_to_close("X260101P00010000", 1.00)
    limit = float(captured["limit_price"])
    assert 1.00 < limit <= 1.10
