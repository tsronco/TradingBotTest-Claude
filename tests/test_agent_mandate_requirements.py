"""The decision mandate has to ask for checkable claims.

These assert the two requirements added after the agent wrote an unfalsifiable
trend claim ("a steady grind higher") about a stock that was not grinding
higher, and reasoned about cheap implied vol without asking why it was cheap.
"""
import agent_trader


MANDATE = agent_trader.SYSTEM_MANDATE


def test_points_the_model_at_the_price_context_payload():
    assert "price_context" in MANDATE


def test_requires_trend_claims_to_carry_a_number():
    assert "unfalsifiable" in MANDATE
    lowered = MANDATE.lower()
    assert "steady grind higher" in lowered      # names the actual failure
    assert "cannot cite a number" in lowered


def test_tells_the_model_missing_history_is_unknown_not_confirmation():
    assert "never treat missing history as confirmation" in MANDATE.lower()


def test_requires_an_explanation_for_the_level_of_implied_vol():
    lowered = MANDATE.lower()
    assert "why implied vol is where it is" in lowered
    assert "days_since_last_earnings" in MANDATE
    assert "days_to_next_earnings" in MANDATE


def test_distinguishes_post_earnings_vol_from_structural_vol():
    lowered = MANDATE.lower()
    assert "after an earnings print" in lowered
    assert "structurally low" in lowered


def test_null_earnings_is_documented_as_unknown_not_none():
    assert 'null means unknown, not "none"' in MANDATE


def test_existing_guidance_survived_the_edit():
    # The mandate is edited by string replacement; make sure neighbouring
    # sections were not clobbered.
    for anchor in [
        "Posture — aim for the middle",
        "How to read a position's P&L",
        "Options Level 3",
        "Call \\\nsubmit_decisions exactly once." if False else "submit_decisions exactly once",
    ]:
        assert anchor in MANDATE, anchor
