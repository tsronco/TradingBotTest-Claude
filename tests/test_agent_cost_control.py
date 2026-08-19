"""Cost controls on the agent's model calls.

Six days of hourly cycles cost ~$15 in API credits on a $2k paper account that
was down $300 — roughly $100/month. The decision call's option-chain payload
was ~85% of it: 24 focus symbols x 40 chain rows, on Opus, at the default
(highest) reasoning effort, with no record of any of it.
"""
import pytest

import agent_config
import agent_trader


def chain(strikes):
    return {
        f"X260925C{int(k * 1000):08d}": {"latestQuote": {"bp": 1.0, "ap": 1.2},
                                         "greeks": {"delta": 0.3},
                                         "impliedVolatility": 0.26}
        for k in strikes
    }


# ── near-the-money selection ───────────────────────────────────────────────

def test_strike_parsed_from_occ():
    assert agent_trader._occ_strike("CVS260925C00096000") == 96.0
    assert agent_trader._occ_strike("CVS260925P00103500") == 103.5


def test_non_occ_symbol_has_no_strike():
    assert agent_trader._occ_strike("CVS") is None
    assert agent_trader._occ_strike("") is None
    assert agent_trader._occ_strike(None) is None


def test_keeps_the_strikes_nearest_spot():
    # The old slice took whatever came first, which could hand the model forty
    # far-OTM strikes and omit the ones a real structure would use.
    kept = agent_trader._trim_chain(chain([50, 80, 94, 95, 96, 130, 200]), spot=95, keep=3)
    assert sorted(agent_trader._occ_strike(k) for k in kept) == [94.0, 95.0, 96.0]


def test_keeps_strikes_on_both_sides_of_spot():
    kept = agent_trader._trim_chain(chain([90, 92, 94, 96, 98, 100]), spot=95, keep=4)
    got = sorted(agent_trader._occ_strike(k) for k in kept)
    assert min(got) < 95 < max(got)


def test_falls_back_to_a_leading_slice_when_spot_is_unknown():
    # A missing quote should cost relevance, never the whole chain.
    kept = agent_trader._trim_chain(chain([50, 80, 95, 130]), spot=None, keep=2)
    assert len(kept) == 2


def test_unparseable_strikes_sort_last_rather_than_crashing():
    c = chain([94, 96])
    c["GARBAGE"] = {"latestQuote": {}}
    kept = agent_trader._trim_chain(c, spot=95, keep=2)
    assert "GARBAGE" not in kept


def test_keeps_the_fields_needed_to_price_a_structure():
    kept = agent_trader._trim_chain(chain([95]), spot=95, keep=1)
    row = next(iter(kept.values()))
    assert set(row) == {"bid", "ask", "greeks", "iv"}


def test_defaults_to_the_configured_keep():
    kept = agent_trader._trim_chain(chain(range(80, 130)), spot=100)
    assert len(kept) == agent_config.AGENT_CONFIG["chain_keep"]


def test_smaller_chain_than_keep_is_returned_whole():
    kept = agent_trader._trim_chain(chain([95, 96]), spot=95, keep=40)
    assert len(kept) == 2


# ── the dials themselves ───────────────────────────────────────────────────

def test_payload_dials_are_below_the_settings_that_caused_the_bill():
    cfg = agent_config.AGENT_CONFIG
    # Depth payload scales as focus_symbols x chain_keep; it was 24 x 40 = 960
    # option rows per cycle.
    assert cfg["max_focus_symbols"] <= 12
    assert cfg["chain_keep"] <= 20
    assert cfg["max_focus_symbols"] * cfg["chain_keep"] < 960 / 2


def test_reasoning_effort_is_set_rather_than_defaulting_to_high():
    cfg = agent_config.AGENT_CONFIG
    assert cfg["focus_effort"] in {"low", "medium"}
    assert cfg["decision_effort"] in {"low", "medium", "high"}


def test_focus_uses_a_cheaper_model_than_the_decision():
    assert agent_config.focus_model() != agent_config.model()
    assert agent_config.focus_model() == "claude-sonnet-5"


def test_focus_model_is_env_overridable(monkeypatch):
    monkeypatch.setenv("AGENT_FOCUS_MODEL", "claude-haiku-4-5")
    assert agent_config.focus_model() == "claude-haiku-4-5"


def test_decision_model_is_unchanged():
    # Cost control must not quietly downgrade the judgment that matters.
    assert agent_config.model() == "claude-opus-5"


# ── usage accounting ───────────────────────────────────────────────────────

class _Usage:
    def __init__(self, i, o, cached=0):
        self.input_tokens = i
        self.output_tokens = o
        self.cache_read_input_tokens = cached


class _Resp:
    def __init__(self, usage):
        self.usage = usage


def test_records_tokens_and_an_estimated_cost():
    u = agent_trader.log_model_usage("decision", "claude-opus-5", _Resp(_Usage(50_000, 4_000)))
    assert u["input_tokens"] == 50_000
    assert u["output_tokens"] == 4_000
    # 50k x $5/MTok + 4k x $25/MTok = 0.25 + 0.10
    assert u["est_cost_usd"] == pytest.approx(0.35, abs=1e-6)


def test_prices_a_cheaper_model_lower():
    opus = agent_trader.log_model_usage("focus", "claude-opus-5", _Resp(_Usage(13_000, 1_000)))
    sonnet = agent_trader.log_model_usage("focus", "claude-sonnet-5", _Resp(_Usage(13_000, 1_000)))
    assert sonnet["est_cost_usd"] < opus["est_cost_usd"]


def test_unknown_model_falls_back_to_the_dearest_rate():
    # Better to overstate a cost estimate than to understate it.
    u = agent_trader.log_model_usage("decision", "some-future-model", _Resp(_Usage(1_000_000, 0)))
    assert u["est_cost_usd"] == pytest.approx(5.0, abs=1e-6)


def test_accounting_never_breaks_a_cycle():
    assert agent_trader.log_model_usage("focus", "claude-opus-5", _Resp(None)) == {}
    assert agent_trader.log_model_usage("focus", "claude-opus-5", object()) == {}
