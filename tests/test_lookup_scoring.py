"""Tests for the wheelability scoring in tools/lookup.py.

The scoring function has no side effects and no Alpaca calls — pure
inputs → score+reasons. So we can test it directly without mocks.
"""

from tools.lookup import (
    compute_wheelability,
    grade_emoji,
    grade_letter,
    score_bp_fit,
    score_holdings_context,
    score_iv,
    score_open_interest,
    score_spread,
)


# ── Component scorers ──────────────────────────────────────────────────────

class TestScoreIV:
    def test_high_iv_full_points(self):
        pts, reason = score_iv(0.35)
        assert pts == 3
        assert "high" in reason.lower()

    def test_moderate_iv_two_points(self):
        pts, _ = score_iv(0.25)
        assert pts == 2

    def test_low_iv_one_point(self):
        pts, _ = score_iv(0.15)
        assert pts == 1

    def test_very_low_iv_zero(self):
        pts, _ = score_iv(0.05)
        assert pts == 0

    def test_missing_iv(self):
        pts, reason = score_iv(None)
        assert pts == 0
        assert "unavailable" in reason.lower()


class TestScoreSpread:
    def test_tight_spread_full_points(self):
        # bid 1.00, ask 1.02 — 2% wide
        pts, reason = score_spread(1.00, 1.02)
        assert pts == 2
        assert "tight" in reason.lower()

    def test_moderate_spread_one_point(self):
        # bid 1.00, ask 1.10 — ~9.5% wide
        pts, _ = score_spread(1.00, 1.10)
        assert pts == 1

    def test_wide_spread_zero(self):
        # bid 1.00, ask 1.40 — ~33% wide
        pts, reason = score_spread(1.00, 1.40)
        assert pts == 0
        assert "illiquid" in reason.lower()

    def test_no_quote_zero(self):
        pts, _ = score_spread(0.0, 0.0)
        assert pts == 0


class TestScoreOpenInterest:
    def test_liquid_oi(self):
        pts, _ = score_open_interest(500)
        assert pts == 1

    def test_at_threshold(self):
        pts, _ = score_open_interest(100)
        assert pts == 1

    def test_thin_oi(self):
        pts, reason = score_open_interest(20)
        assert pts == 0
        assert "thin" in reason.lower()

    def test_missing_oi(self):
        pts, _ = score_open_interest(None)
        assert pts == 0


class TestScoreBPFit:
    def test_easy_fit(self):
        # $50 strike → $5,000 collateral, $100k BP → 5% — full point
        pts, _ = score_bp_fit(50.0, 100_000.0)
        assert pts == 1

    def test_heavy_but_under_50pct(self):
        # $100 strike → $10k collateral, $25k BP → 40% — heavy, 0 points
        pts, reason = score_bp_fit(100.0, 25_000.0)
        assert pts == 0
        assert "heavy" in reason.lower()

    def test_too_much(self):
        # $100 strike, $15k BP → 67%
        pts, reason = score_bp_fit(100.0, 15_000.0)
        assert pts == 0
        assert "too much" in reason.lower()

    def test_zero_bp(self):
        pts, reason = score_bp_fit(50.0, 0.0)
        assert pts == 0
        assert "unknown" in reason.lower()


class TestScoreHoldings:
    def test_no_position(self):
        pts, reason = score_holdings_context(None)
        assert pts == 0
        assert "fresh CSP" in reason

    def test_full_lot(self):
        pts, reason = score_holdings_context({"qty": "100"})
        assert pts == 1
        assert "covered-call" in reason.lower()

    def test_more_than_lot(self):
        pts, _ = score_holdings_context({"qty": "250"})
        assert pts == 1

    def test_partial_lot(self):
        pts, reason = score_holdings_context({"qty": "50"})
        assert pts == 0
        assert "not yet" in reason.lower()


# ── Grade letters / emoji ──────────────────────────────────────────────────

class TestGrade:
    def test_letter_a(self):
        assert grade_letter(8, 8) == "A"
        assert grade_letter(7, 8) == "A"  # 87.5%

    def test_letter_b(self):
        assert grade_letter(6, 8) == "B"  # 75%

    def test_letter_c(self):
        assert grade_letter(5, 8) == "C"  # 62.5%

    def test_letter_d(self):
        assert grade_letter(4, 8) == "D"  # 50%

    def test_letter_f(self):
        assert grade_letter(2, 8) == "F"
        assert grade_letter(0, 8) == "F"

    def test_emoji_green(self):
        assert grade_emoji(7, 8) == "🟢"

    def test_emoji_yellow(self):
        assert grade_emoji(4, 8) == "🟡"

    def test_emoji_red(self):
        assert grade_emoji(2, 8) == "🔴"


# ── Composite scoring ──────────────────────────────────────────────────────

class TestComputeWheelability:
    def test_ideal_setup(self):
        """High IV, tight spread, deep OI, easy BP fit, holdings present."""
        result = compute_wheelability(
            iv=0.35,
            bid=1.00,
            ask=1.02,
            open_interest=500,
            strike=50.0,
            options_bp=100_000.0,
            stock_position={"qty": "100"},
        )
        assert result["score"] == 8
        assert result["max_score"] == 8
        assert result["grade"] == "A"
        assert result["emoji"] == "🟢"
        assert len(result["reasons"]) == 5

    def test_terrible_setup(self):
        """Low IV, wide spread, no OI, no BP, no holdings."""
        result = compute_wheelability(
            iv=0.05,
            bid=0.0,
            ask=0.0,
            open_interest=None,
            strike=200.0,
            options_bp=0.0,
            stock_position=None,
        )
        assert result["score"] == 0
        assert result["grade"] == "F"
        assert result["emoji"] == "🔴"

    def test_middling_setup(self):
        """Moderate IV, ok spread, low OI, fits BP, no holdings."""
        result = compute_wheelability(
            iv=0.22,
            bid=1.00,
            ask=1.08,
            open_interest=50,
            strike=50.0,
            options_bp=100_000.0,
            stock_position=None,
        )
        # IV: 2, spread: 1, OI: 0, BP: 1, holdings: 0  →  4
        assert result["score"] == 4
        assert result["grade"] == "D"

    def test_max_score_invariant(self):
        """max_score is the documented total of component maximums."""
        # IV(3) + spread(2) + OI(1) + BP(1) + holdings(1) = 8
        result = compute_wheelability(
            iv=0.20, bid=0.5, ask=0.55, open_interest=100,
            strike=50.0, options_bp=100_000.0, stock_position=None,
        )
        assert result["max_score"] == 8

    def test_reasons_are_strings(self):
        result = compute_wheelability(
            iv=0.25, bid=1.0, ask=1.05, open_interest=200,
            strike=80.0, options_bp=50_000.0, stock_position={"qty": "100"},
        )
        assert all(isinstance(r, str) for r in result["reasons"])
