"""Tests for wheel_screener.py.

Covers:
  - Strike rounding at different price levels
  - Universe sanity (no overlap with already-wheeled symbols)
  - score_candidate happy path + every skip path
  - Score formula breakdown
  - Embed line formatting
"""
from unittest.mock import patch

import wheel_screener as ws


# ── Universe sanity ───────────────────────────────────────────────────────


def test_universe_excludes_already_wheeled():
    overlap = set(ws.UNIVERSE) & ws.ALREADY_WHEELED
    assert overlap == set(), f"universe overlaps wheel: {overlap}"


def test_universe_is_nonempty_and_unique():
    assert len(ws.UNIVERSE) > 10
    assert len(ws.UNIVERSE) == len(set(ws.UNIVERSE))


# ── round_strike ──────────────────────────────────────────────────────────


def test_round_strike_under_25_uses_dollar_increment():
    assert ws.round_strike(13.7, reference_price=15) == 14.0
    assert ws.round_strike(8.4,  reference_price=10) == 8.0
    assert ws.round_strike(22.6, reference_price=22) == 23.0


def test_round_strike_at_or_above_25_uses_5_dollar_increment():
    assert ws.round_strike(47.0,  reference_price=50)  == 45.0
    assert ws.round_strike(48.0,  reference_price=50)  == 50.0
    assert ws.round_strike(123.0, reference_price=130) == 125.0
    assert ws.round_strike(338.0, reference_price=375) == 340.0


# ── score_candidate ───────────────────────────────────────────────────────


def _stub_contract(strike=45.0, expiry="2026-05-22", symbol="BAC260522P00045000"):
    return {
        "symbol":           symbol,
        "strike_price":     strike,
        "expiration_date":  expiry,
    }


def test_score_candidate_happy_path():
    with patch.object(ws, "get_latest_stock_price", return_value=50.0), \
         patch.object(ws, "find_best_put", return_value=_stub_contract(strike=45.0)), \
         patch.object(ws, "get_option_quote", return_value={"bid": 0.40, "ask": 0.50}):
        r = ws.score_candidate("BAC", free_bp=10_000)

    assert r is not None
    assert r["symbol"]        == "BAC"
    assert r["price"]         == 50.0
    assert r["strike"]        == 45.0
    assert r["bid"]           == 0.40
    assert r["ask"]           == 0.50
    assert r["mid"]           == 0.45
    assert r["collateral"]    == 4500.0
    assert r["budget_fit"] is True

    # Check formula directly
    expected_yield  = 0.40 / 45.0
    expected_spread = (0.50 - 0.40) / 0.45
    expected_score  = expected_yield * 100 - expected_spread * 50 + 5
    assert abs(r["premium_yield"] - expected_yield)  < 1e-9
    assert abs(r["spread_pct"]    - expected_spread) < 1e-9
    assert abs(r["score"]         - expected_score)  < 1e-9


def test_score_candidate_skips_low_priced_stocks():
    with patch.object(ws, "get_latest_stock_price", return_value=2.50):
        assert ws.score_candidate("PENNY", free_bp=10_000) is None


def test_score_candidate_skips_when_price_lookup_fails():
    with patch.object(ws, "get_latest_stock_price", return_value=None):
        assert ws.score_candidate("XYZ", free_bp=10_000) is None


def test_score_candidate_skips_when_no_contract_found():
    with patch.object(ws, "get_latest_stock_price", return_value=50.0), \
         patch.object(ws, "find_best_put", return_value=None):
        assert ws.score_candidate("XYZ", free_bp=10_000) is None


def test_score_candidate_skips_when_no_quote():
    with patch.object(ws, "get_latest_stock_price", return_value=50.0), \
         patch.object(ws, "find_best_put", return_value=_stub_contract()), \
         patch.object(ws, "get_option_quote", return_value=None):
        assert ws.score_candidate("XYZ", free_bp=10_000) is None


def test_score_candidate_skips_when_mid_is_zero():
    with patch.object(ws, "get_latest_stock_price", return_value=50.0), \
         patch.object(ws, "find_best_put", return_value=_stub_contract()), \
         patch.object(ws, "get_option_quote", return_value={"bid": 0.0, "ask": 0.0}):
        assert ws.score_candidate("XYZ", free_bp=10_000) is None


def test_score_candidate_budget_fit_false_when_collateral_exceeds_bp():
    """Strike $340 × 100 = $34,000 collateral; only $10k free BP → over budget."""
    with patch.object(ws, "get_latest_stock_price", return_value=375.0), \
         patch.object(ws, "find_best_put", return_value=_stub_contract(strike=340.0)), \
         patch.object(ws, "get_option_quote", return_value={"bid": 4.0, "ask": 4.2}):
        r = ws.score_candidate("TSLA", free_bp=10_000)

    assert r is not None
    assert r["collateral"]      == 34_000.0
    assert r["budget_fit"]   is False
    # Score should NOT include the +5 budget_fit bonus.
    bonus_excluded_score = (4.0 / 340.0) * 100 - ((4.2 - 4.0) / 4.1) * 50
    assert abs(r["score"] - bonus_excluded_score) < 1e-9


def test_score_candidate_budget_fit_true_when_collateral_equals_bp():
    """Boundary: collateral exactly equals BP — should still fit."""
    with patch.object(ws, "get_latest_stock_price", return_value=20.0), \
         patch.object(ws, "find_best_put", return_value=_stub_contract(strike=18.0)), \
         patch.object(ws, "get_option_quote", return_value={"bid": 0.50, "ask": 0.55}):
        r = ws.score_candidate("XYZ", free_bp=1800.0)

    assert r["collateral"]    == 1800.0
    assert r["budget_fit"] is True


# ── build_embed_lines ─────────────────────────────────────────────────────


def test_build_embed_lines_renders_each_candidate():
    top = [
        {"symbol": "JPM", "price": 220.50, "strike": 200.0, "expiry": "2026-05-22",
         "mid": 1.20, "premium_yield": 0.006, "spread_pct": 0.05, "budget_fit": True},
        {"symbol": "TSLA", "price": 380.0, "strike": 340.0, "expiry": "2026-05-22",
         "mid": 4.10, "premium_yield": 0.012, "spread_pct": 0.04, "budget_fit": False},
    ]
    lines = ws.build_embed_lines(top)
    assert len(lines) == 2

    assert "**1. JPM**"   in lines[0]
    assert "$220.50"      in lines[0]
    assert "$200P"        in lines[0]
    assert "fits BP"      in lines[0]
    assert "premium $120" in lines[0]

    assert "**2. TSLA**"  in lines[1]
    assert "OVER BP"      in lines[1]
