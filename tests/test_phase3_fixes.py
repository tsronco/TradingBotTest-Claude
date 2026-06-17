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


# ── R19: place_buy_to_close caps the auto-lookup at the bot's tracked qty ─────

def test_btc_caps_at_tracked_qty(monkeypatch, manual_mode):
    captured = {}
    monkeypatch.setattr(ws, "api_post", lambda p, b: captured.update(b) or {"id": "o"})
    # live position has 3 contracts but the bot tracks only 1 (user hand-sold 2)
    monkeypatch.setattr(ws, "get_option_position", lambda c: {"qty": "-3"})
    ws.place_buy_to_close("X260101P00010000", 0.20, max_qty=1)
    assert captured["qty"] == "1"  # capped — leaves the user's extra 2 alone


def test_btc_no_cap_closes_full_position(monkeypatch, manual_mode):
    captured = {}
    monkeypatch.setattr(ws, "api_post", lambda p, b: captured.update(b) or {"id": "o"})
    monkeypatch.setattr(ws, "get_option_position", lambda c: {"qty": "-3"})
    ws.place_buy_to_close("X260101P00010000", 0.20)  # no cap → full (legacy)
    assert captured["qty"] == "3"


def test_btc_cap_above_live_position_closes_what_exists(monkeypatch, manual_mode):
    captured = {}
    monkeypatch.setattr(ws, "api_post", lambda p, b: captured.update(b) or {"id": "o"})
    monkeypatch.setattr(ws, "get_option_position", lambda c: {"qty": "-2"})
    ws.place_buy_to_close("X260101P00010000", 0.20, max_qty=5)  # cap > live → close live
    assert captured["qty"] == "2"


# ── R21: discovery doesn't clobber a second short on the same underlying ──────

def test_discover_keeps_first_short_does_not_clobber_second(monkeypatch, manual_mode):
    positions = [
        {"symbol": "AAL260918P00013000", "qty": "-1", "avg_entry_price": "0.50", "asset_class": "us_option"},
        {"symbol": "AAL260918P00012000", "qty": "-1", "avg_entry_price": "0.30", "asset_class": "us_option"},
    ]
    monkeypatch.setattr(ws, "get_positions", lambda: positions)
    monkeypatch.setattr(ws, "send_embed", lambda *a, **k: None)
    state = {"_meta": {}}
    ws._discover_wheel_state(state)
    tracked = state["AAL"]["current_contract"]
    assert tracked in ("AAL260918P00013000", "AAL260918P00012000")
    # A second discovery pass must not overwrite the tracked contract.
    ws._discover_wheel_state(state)
    assert state["AAL"]["current_contract"] == tracked


# ── R23: run_wheel skips discovery (no API calls / embeds) when market closed ─

def test_run_wheel_skips_discovery_when_market_closed(monkeypatch, manual_mode, tmp_path):
    import json
    state_file = tmp_path / "wheel_state_manual.json"
    state_file.write_text(json.dumps({"_meta": {}}))
    monkeypatch.setattr(ws, "STATE_FILE", str(state_file))
    monkeypatch.setattr(ws, "is_market_open", lambda: False)
    called = []
    monkeypatch.setattr(ws, "_discover_wheel_state", lambda state: called.append("disc") or set())
    monkeypatch.setattr(ws, "get_positions", lambda: called.append("pos") or [])
    ws.run_wheel()
    assert called == []  # no discovery / position lookups off-hours
