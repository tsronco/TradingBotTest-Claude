# tests/test_screener_core.py
"""Parity tests for screener_core — pin the scoring math so refactors cannot
drift the formula away from the legacy wheel_screener.py implementation."""
import screener_core


def test_score_formula_matches_legacy_constants():
    # Pin the exact scoring math so the refactor cannot drift it.
    r = screener_core.score_from_quote(strike=100.0, bid=2.0, ask=2.2, free_bp=50_000.0)
    # premium_yield = bid/strike = 0.02 -> *100 = 2.0
    # spread_pct = (ask-bid)/mid = 0.2/2.1 = 0.095238 -> *50 = 4.7619
    # budget_fit = collateral(100*100=10000) <= 50000 -> 1.0 -> *5 = 5
    assert round(r["premium_yield"], 6) == 0.02
    assert round(r["score"], 4) == round(2.0 - 4.7619047619 + 5.0, 4)
    assert r["budget_fit"] is True


def test_budget_fit_false_when_collateral_exceeds_bp():
    r = screener_core.score_from_quote(strike=100.0, bid=2.0, ask=2.1, free_bp=5_000.0)
    assert r["budget_fit"] is False  # 10000 > 5000


def test_score_from_quote_formula_components():
    """Verify each component of the score formula individually."""
    r = screener_core.score_from_quote(strike=45.0, bid=0.40, ask=0.50, free_bp=10_000.0)
    expected_yield = 0.40 / 45.0
    expected_spread = (0.50 - 0.40) / 0.45
    expected_score = expected_yield * 100 - expected_spread * 50 + 1.0 * 5
    assert abs(r["premium_yield"] - expected_yield) < 1e-9
    assert abs(r["spread_pct"] - expected_spread) < 1e-9
    assert abs(r["score"] - expected_score) < 1e-9
    assert r["budget_fit"] is True  # 4500 <= 10000


def test_score_from_quote_budget_boundary():
    """Collateral exactly equal to free_bp should still fit."""
    r = screener_core.score_from_quote(strike=18.0, bid=0.50, ask=0.55, free_bp=1800.0)
    assert r["budget_fit"] is True  # 1800 <= 1800


def test_build_universe_excludes_already_wheeled():
    result = screener_core.build_universe(["AAPL", "MSFT", "BAC", "T"], already_wheeled=["BAC"])
    assert "BAC" not in result
    assert "AAPL" in result
    assert "MSFT" in result


def test_build_universe_uses_default_when_cfg_is_none():
    result = screener_core.build_universe(None, already_wheeled=[])
    assert len(result) > 10
    # Should match sorted(set(DEFAULT_CONSERVATIVE_UNIVERSE) - set([]))
    assert result == sorted(set(screener_core.DEFAULT_CONSERVATIVE_UNIVERSE) - set())


def test_build_universe_returns_sorted():
    result = screener_core.build_universe(["C", "A", "B"], already_wheeled=[])
    assert result == ["A", "B", "C"]


def test_universe_size_and_quality():
    """Expanded universe: 105-130 names, valid/unique, ≥30 cheap (≤$25) names."""
    u = screener_core.DEFAULT_CONSERVATIVE_UNIVERSE
    assert 105 <= len(u) <= 130, f"Universe size {len(u)} not in [105, 130]"
    assert all(isinstance(s, str) and s == s.upper() and len(s) > 0 for s in u)
    assert len(u) == len(set(u)), "Universe has duplicates"
    KNOWN_CHEAP = {
        "F", "T", "INTC", "SOFI", "PFE", "BAC", "NIO", "CCL", "KMI", "AAL",
        "NOK", "SNAP", "WBD", "PARA", "NCLH", "HOOD", "RIVN", "CLF", "VALE",
        "KGC", "GOLD", "AES", "KEY", "RF", "HBAN", "FITB", "ALLY", "SYF",
        "MOS", "SIRI", "KSS", "M", "HPE", "GRAB",
    }
    present_cheap = KNOWN_CHEAP & set(u)
    assert len(present_cheap) >= 30, (
        f"Only {len(present_cheap)} cheap names: {sorted(present_cheap)}; need ≥30"
    )


def test_score_candidate_with_injected_api_get():
    """score_candidate uses injected api_get and returns the legacy dict shape."""
    contract = {
        "symbol": "BAC260522P00045000",
        "strike_price": 45.0,
        "expiration_date": "2026-05-22",
    }
    quote = {"bid": 0.40, "ask": 0.50}

    call_log = []

    def fake_api_get(path, params=None):
        call_log.append(path)
        if "/options/contracts" in path:
            return {"option_contracts": [contract]}
        raise ValueError(f"unexpected path: {path}")

    import unittest.mock as mock
    with mock.patch("screener_core._get_latest_price", return_value=50.0), \
         mock.patch("screener_core._get_option_quote", return_value=quote):
        r = screener_core.score_candidate(
            "BAC", free_bp=10_000.0, api_get=fake_api_get,
            target_dte_min=14, target_dte_max=28, put_strike_discount=0.10,
        )

    assert r is not None
    # Verify legacy dict keys
    for key in ("symbol", "price", "strike", "expiry", "option_symbol",
                "bid", "ask", "mid", "premium_yield", "spread_pct",
                "collateral", "budget_fit", "score"):
        assert key in r, f"missing key: {key}"
    assert r["symbol"] == "BAC"
    assert r["strike"] == 45.0
    assert r["bid"] == 0.40
    assert r["ask"] == 0.50
    assert r["budget_fit"] is True
    # Hand-computed: bid=0.40, ask=0.50, strike=45.0, free_bp=10000.0
    # mid=0.45, premium_yield=0.40/45, spread_pct=0.10/0.45, budget_num=1.0
    # score = (0.40/45)*100 - (0.10/0.45)*50 + 1.0*5
    expected_score = (0.40 / 45.0) * 100 - (0.10 / 0.45) * 50 + 1.0 * 5
    assert abs(r["score"] - expected_score) < 1e-9


def test_sm_curated_universe_excludes_junk_tier():
    """The new SM list must NOT contain the cheap-junk names that the
    old sm500 max_underlying_price:25 filter was selecting into."""
    junk = {"NCLH", "HPQ", "KSS", "RIVN", "M", "NIO", "AAL", "WBD", "PARA"}
    assert junk.isdisjoint(set(screener_core.SM_CURATED_UNIVERSE))


def test_sm_curated_universe_is_subset_of_quality_names():
    """Spot-check: every SM name appears in the larger conservative
    universe (no surprise picks)."""
    assert set(screener_core.SM_CURATED_UNIVERSE).issubset(
        set(screener_core.DEFAULT_CONSERVATIVE_UNIVERSE)
    )


def test_sm_curated_universe_size():
    """Tight list — under 20 names so the screener's scoring loop
    doesn't waste API calls on borderline tickers."""
    assert 8 <= len(screener_core.SM_CURATED_UNIVERSE) <= 18


def test_is_above_sma20_returns_true_when_price_above_average():
    # 20 closes averaging 10.00; current price 11.00 → above SMA → True
    closes = [10.0] * 20
    fetch = lambda sym: closes
    assert screener_core.is_above_sma20("ANY", 11.0, fetch) is True


def test_is_above_sma20_returns_false_when_price_below_average():
    closes = [10.0] * 20
    fetch = lambda sym: closes
    assert screener_core.is_above_sma20("ANY", 9.0, fetch) is False


def test_is_above_sma20_boundary_inclusive():
    # price exactly == SMA20 counts as above (don't reject borderline)
    closes = [10.0] * 20
    fetch = lambda sym: closes
    assert screener_core.is_above_sma20("ANY", 10.0, fetch) is True


def test_is_above_sma20_insufficient_history_returns_false():
    # No 20 days of data → conservative fail-closed: treat as below
    # (don't sell puts on a symbol we can't verify the trend on)
    fetch = lambda sym: [10.0] * 5
    assert screener_core.is_above_sma20("ANY", 11.0, fetch) is False


def test_is_above_sma20_fetch_returns_none_is_false():
    fetch = lambda sym: None
    assert screener_core.is_above_sma20("ANY", 11.0, fetch) is False


def test_is_above_sma20_fetch_raises_is_false():
    def boom(sym):
        raise RuntimeError("network down")
    assert screener_core.is_above_sma20("ANY", 11.0, boom) is False
