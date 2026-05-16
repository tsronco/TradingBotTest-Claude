"""Tests for the autonomous put-credit-spread opener (Phase 4).

Everything is mocked — no test ever touches Alpaca or yfinance:
  - screener_core.score_candidate, get_account, earnings.next_earnings_within,
    contract lookup, and _open_spread_mleg are all patched.

Coverage:
  4.1  normalize_scores (percentile 0-100, singleton, empty)
       bp_wants_spread (BP switch)
  4.2  risk-rail predicates: spread_passes_risk, under_concurrency,
       above_account_floor, bp_fits, eligible_universe
  4.3  _open_spread_mleg (exact mleg body, credit-convention limit price)
  4.4  _auto_open_spread orchestration + per-cycle wiring (7 behaviors)
"""
import wheel_strategy as ws


# ── Task 4.1: score normalization + BP switch ────────────────────────────

def test_normalize_scores_percentile_0_100():
    raw = {"A": 2.0, "B": 4.0, "C": 6.0, "D": 8.0, "E": 10.0}
    norm = ws.normalize_scores(raw)
    assert norm["E"] == 100.0          # top
    assert norm["A"] == 0.0            # bottom
    assert 40.0 <= norm["C"] <= 60.0   # mid ~50th pct
    assert all(0.0 <= v <= 100.0 for v in norm.values())


def test_normalize_scores_singleton_is_top():
    assert ws.normalize_scores({"X": 3.3}) == {"X": 100.0}


def test_normalize_scores_empty():
    assert ws.normalize_scores({}) == {}


def test_bp_wants_spread_below_threshold():
    assert ws.bp_wants_spread(options_bp=1800.0, threshold=5000) is True
    assert ws.bp_wants_spread(options_bp=12000.0, threshold=5000) is False


# ── Task 4.2: risk-rail predicates ───────────────────────────────────────

def test_spread_passes_risk_exact_arithmetic():
    # max loss = width*100; pass iff <= equity * max_risk_pct
    # $1 wide on a $500 account @ 12%: 100 > 60 -> False
    assert ws.spread_passes_risk(1.0, 500, 0.12) is False
    # $1 wide on a $1000 account @ 12%: 100 <= 120 -> True
    assert ws.spread_passes_risk(1.0, 1000, 0.12) is True
    # exact boundary: 100 <= 100 -> True
    assert ws.spread_passes_risk(1.0, 1000, 0.10) is True
    # $0.50 wide on $500 @ 12%: 50 <= 60 -> True (sm500 can fit a narrow one)
    assert ws.spread_passes_risk(0.5, 500, 0.12) is True


def test_under_concurrency():
    assert ws.under_concurrency(0, 3) is True
    assert ws.under_concurrency(2, 3) is True
    assert ws.under_concurrency(3, 3) is False
    assert ws.under_concurrency(4, 3) is False


def test_above_account_floor():
    assert ws.above_account_floor(300, 300) is True   # boundary inclusive
    assert ws.above_account_floor(500, 300) is True
    assert ws.above_account_floor(299.99, 300) is False


def test_bp_fits():
    # need options_bp >= width*100 * buffer
    assert ws.bp_fits(100.0, 1.0) is True             # 100 >= 100
    assert ws.bp_fits(99.0, 1.0) is False             # 99 < 100
    assert ws.bp_fits(150.0, 1.0, buffer=1.2) is True   # 150 >= 120
    assert ws.bp_fits(110.0, 1.0, buffer=1.2) is False  # 110 < 120


def test_eligible_universe_filters_by_price():
    prices = {"CHEAP": 12.0, "MID": 25.0, "PRICEY": 40.0}
    # max_price None -> everything passes
    assert sorted(ws.eligible_universe(prices, None)) == ["CHEAP", "MID", "PRICEY"]
    # max_price 25 -> price <= 25 (inclusive)
    assert sorted(ws.eligible_universe(prices, 25)) == ["CHEAP", "MID"]
    # max_price 20 -> only CHEAP
    assert ws.eligible_universe(prices, 20) == ["CHEAP"]
