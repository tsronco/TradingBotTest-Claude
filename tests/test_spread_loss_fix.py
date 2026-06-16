"""Tests for the 2026-05-30 spread-loss fixes.

Root cause: the engine decided on MID prices but executed and stopped on the
worst-case bid/ask cross, so on wide chains it opened cheap, stopped out on the
spread itself, and orphaned hedge legs that then rotted. These tests pin the
fixes:

  A. compute_open_limit_credit — rest near the mid, don't cross the full bid/ask
  B. liquidity gate — reject opens whose executable credit is a fraction of mid
  C. handle_spread stop on the MID + manual underlying tripwire + settling guard
  D. marketable orphan close + long_options urgent (marketable) close
  E. naked-leg guards (short side in wheel, long side in long_options)
"""
import wheel_strategy as ws
import long_options_strategy as los

from tests.test_auto_spread import _wire_sm, _contract  # reuse the SM wiring harness


# ── A. compute_open_limit_credit (rest near the mid) ─────────────────────────

def test_open_limit_rests_at_mid_when_no_concession():
    # concession 0 → place exactly at the mid (best price)
    assert ws.compute_open_limit_credit(0.35, 0.25, 0.0, 0.0) == 0.35


def test_open_limit_full_cross_when_concession_one():
    # concession 1.0, no floor → legacy full marketable cross
    assert ws.compute_open_limit_credit(0.35, 0.25, 1.0, 0.0) == 0.25


def test_open_limit_partial_concession_lands_between_mid_and_marketable():
    # MU shape: mid 3.65, marketable 1.50, concession 0.40 → 3.65 - 0.40*2.15
    assert ws.compute_open_limit_credit(3.65, 1.50, 0.40, 0.60) == 2.79


def test_open_limit_never_below_min_pct_of_mid():
    # marketable 0.10 would pull a full cross way down; floor at 60% of mid
    assert ws.compute_open_limit_credit(1.00, 0.10, 1.0, 0.60) == 0.60


def test_open_limit_degenerate_mid_falls_back_to_marketable():
    assert ws.compute_open_limit_credit(0.0, 0.05, 0.40, 0.60) == 0.05


def test_open_limit_floored_at_one_cent():
    assert ws.compute_open_limit_credit(0.0, 0.0, 0.40, 0.60) == 0.01


# ── B. liquidity gate + near-mid opening price in the live opener ─────────────

def _cheap_spread_wiring(monkeypatch, quotes):
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
        ("CHEAP", 16.0): _contract("CHEAP260612P00016000", 16.0),
    }
    return _wire_sm(
        monkeypatch, equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={}, contracts_by_strike=contracts, quotes=quotes,
    )


def test_opener_rejects_wide_chain_below_pct_of_mid(monkeypatch):
    """Mid ratio passes but the executable credit is only ~29% of the mid —
    the MU pathology. With the liquidity floor armed, the spread is skipped."""
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.50, "ask": 0.70},  # mid 0.60
        "CHEAP260612P00017000": {"bid": 0.10, "ask": 0.40},  # mid 0.25
        # mid net 0.35 (ratio 0.35 >= 0.33 OK); exec = 0.50 - 0.40 = 0.10
        "CHEAP260612P00016000": {"bid": 0.05, "ask": 0.45},
    }
    cfg, opened = _cheap_spread_wiring(monkeypatch, quotes)
    monkeypatch.setattr(ws, "SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID", 0.60)
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert opened == []  # 0.10 / 0.35 = 29% < 60% → skipped


def test_opener_places_near_mid_not_full_cross(monkeypatch):
    """With a healthy chain and a 0.40 concession, the order rests between the
    mid (0.35) and the marketable cross (0.25), not at the full cross."""
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.55, "ask": 0.65},  # mid 0.60
        "CHEAP260612P00017000": {"bid": 0.20, "ask": 0.30},  # mid 0.25
        "CHEAP260612P00016000": {"bid": 0.18, "ask": 0.26},
    }
    cfg, opened = _cheap_spread_wiring(monkeypatch, quotes)
    monkeypatch.setattr(ws, "SPREAD_OPEN_CONCESSION_PCT", 0.40)
    monkeypatch.setattr(ws, "SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID", 0.0)
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert len(opened) == 1
    # 0.35 - 0.40*(0.35-0.25) = 0.31 ; recorded credit stays the mid
    assert round(opened[0]["limit_credit"], 2) == 0.31
    assert round(opened[0]["net_credit"], 2) == 0.35


# ── C. settling window ───────────────────────────────────────────────────────

def test_settling_window_off_when_disabled(monkeypatch):
    monkeypatch.setattr(ws, "SPREAD_SETTLE_MINUTES", 0)
    assert ws._within_settling_window({"opened_at": _now_iso()}) is False


def test_settling_window_suppresses_recent_open(monkeypatch):
    monkeypatch.setattr(ws, "SPREAD_SETTLE_MINUTES", 20)
    assert ws._within_settling_window({"opened_at": _now_iso()}) is True


def test_settling_window_does_not_suppress_when_open_time_unknown(monkeypatch):
    # Missing opened_at must NOT read as "just opened" (that would disable the
    # stop forever). Returns False so the stop can still fire.
    monkeypatch.setattr(ws, "SPREAD_SETTLE_MINUTES", 20)
    assert ws._within_settling_window({}) is False


def test_settling_window_expired_after_window(monkeypatch):
    monkeypatch.setattr(ws, "SPREAD_SETTLE_MINUTES", 20)
    from datetime import datetime, timezone, timedelta
    old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    assert ws._within_settling_window({"opened_at": old}) is False


def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ── E. naked-leg guard (short side, wheel_strategy) ──────────────────────────

def test_short_put_hedge_detected():
    sym_state = {"stage": 1, "contract_type": "put",
                 "contract_strike": 13.5, "contract_expiration": "2026-06-12"}
    positions = [
        {"symbol": "AAL260612P00012500", "asset_class": "us_option", "qty": "1"},
    ]
    assert ws._short_put_has_live_hedge("AAL", sym_state, positions) is True


def test_short_put_no_hedge_at_different_expiry():
    sym_state = {"stage": 1, "contract_type": "put",
                 "contract_strike": 13.5, "contract_expiration": "2026-06-12"}
    positions = [
        {"symbol": "AAL260619P00012500", "asset_class": "us_option", "qty": "1"},
    ]
    assert ws._short_put_has_live_hedge("AAL", sym_state, positions) is False


def test_short_put_no_hedge_when_long_strike_above_short():
    # A long put ABOVE the short is not the hedge of a put credit spread
    sym_state = {"stage": 1, "contract_type": "put",
                 "contract_strike": 13.5, "contract_expiration": "2026-06-12"}
    positions = [
        {"symbol": "AAL260612P00014000", "asset_class": "us_option", "qty": "1"},
    ]
    assert ws._short_put_has_live_hedge("AAL", sym_state, positions) is False


def test_short_put_guard_ignores_non_put_or_non_stage1():
    positions = [
        {"symbol": "AAL260612P00012500", "asset_class": "us_option", "qty": "1"},
    ]
    assert ws._short_put_has_live_hedge(
        "AAL", {"stage": 2, "contract_type": "put",
                "contract_strike": 13.5, "contract_expiration": "2026-06-12"},
        positions) is False
    assert ws._short_put_has_live_hedge(
        "AAL", {"stage": 1, "contract_type": "call",
                "contract_strike": 13.5, "contract_expiration": "2026-06-12"},
        positions) is False


# ── E. hedge guard (long side, long_options_strategy) ────────────────────────

def test_unpaired_hedge_long_detected():
    positions = [
        # short put at 13.50 + long put at 12.50, same expiry → the long is a hedge
        {"symbol": "AAL260612P00013500", "asset_class": "us_option", "qty": "-1"},
        {"symbol": "AAL260612P00012500", "asset_class": "us_option", "qty": "1"},
    ]
    hedges = los._unpaired_hedge_long_occs(positions)
    assert "AAL260612P00012500" in hedges
    assert "AAL260612P00013500" not in hedges  # the short isn't a long hedge


def test_unpaired_hedge_long_none_without_short():
    positions = [
        {"symbol": "AAL260612P00012500", "asset_class": "us_option", "qty": "1"},
    ]
    assert los._unpaired_hedge_long_occs(positions) == set()


def test_unpaired_hedge_long_none_at_mismatched_expiry():
    positions = [
        {"symbol": "AAL260612P00013500", "asset_class": "us_option", "qty": "-1"},
        {"symbol": "AAL260619P00012500", "asset_class": "us_option", "qty": "1"},
    ]
    assert los._unpaired_hedge_long_occs(positions) == set()


# ── R32: call credit spread long-call hedge (naked-short-call hole) ──────────

def test_unpaired_hedge_long_call_detected():
    # call credit spread: short call at 14.50 (LOWER) + long call at 15.50
    # (HIGHER), same expiry → the long call is the hedge and must NOT be sold.
    positions = [
        {"symbol": "NVDA260612C00014500", "asset_class": "us_option", "qty": "-1"},
        {"symbol": "NVDA260612C00015500", "asset_class": "us_option", "qty": "1"},
    ]
    hedges = los._unpaired_hedge_long_occs(positions)
    assert "NVDA260612C00015500" in hedges
    assert "NVDA260612C00014500" not in hedges  # the short isn't a long hedge


def test_unpaired_hedge_long_call_not_protected_when_short_is_higher():
    # short call ABOVE the long call = a call DEBIT spread; the long is the
    # primary leg, not a hedge to protect-from-selling.
    positions = [
        {"symbol": "NVDA260612C00015500", "asset_class": "us_option", "qty": "-1"},
        {"symbol": "NVDA260612C00014500", "asset_class": "us_option", "qty": "1"},
    ]
    assert los._unpaired_hedge_long_occs(positions) == set()


def test_unpaired_hedge_put_and_call_do_not_cross():
    # A short put must not protect a long call (and vice versa) — type-matched.
    positions = [
        {"symbol": "AAL260612P00013500", "asset_class": "us_option", "qty": "-1"},
        {"symbol": "AAL260612C00012500", "asset_class": "us_option", "qty": "1"},
    ]
    assert los._unpaired_hedge_long_occs(positions) == set()


# ── D. long_options urgent close prices marketable ───────────────────────────

def test_compute_close_price_urgent_hits_bid(monkeypatch):
    monkeypatch.setattr(los, "get_option_quote",
                        lambda occ: {"bid": 0.05, "ask": 0.25})
    # urgent → take the bid so the order actually fills (AAL daily-churn fix)
    assert los.compute_close_price("X", urgent=True) == 0.05
    # non-urgent (take-profit) → mid, no rush to give away the spread
    assert los.compute_close_price("X", urgent=False) == 0.15


def test_compute_close_price_urgent_floored_at_cent(monkeypatch):
    monkeypatch.setattr(los, "get_option_quote",
                        lambda occ: {"bid": 0.0, "ask": 0.20})
    assert los.compute_close_price("X", urgent=True) == 0.01


# ── D. orphan close prices marketable (so it actually fills) ─────────────────

def _orphan_state():
    return {
        "AAL": {
            "stage": "spread_active", "spread_type": "put_credit",
            "short_leg": {"occ": "AAL260612P00013500", "strike": 13.5,
                          "entry_premium": 0.29, "qty": 1},
            "long_leg":  {"occ": "AAL260612P00012500", "strike": 12.5,
                          "entry_premium": 0.05, "qty": 1},
            "expiration": "2026-06-12", "net_credit": 0.24, "max_loss": 0.76,
            "width": 1.0, "opened_at": "2026-05-14T17:00:00Z",
        }
    }


def test_orphan_long_closes_at_bid_not_mid(monkeypatch):
    """Short gone, long present → STC the long at the BID (marketable) so the
    order fills instead of resting at the mid forever (the AAL orphan bug)."""
    state = _orphan_state()
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ: {"bid": 0.04, "ask": 0.30})  # mid 0.17
    sells = []
    monkeypatch.setattr(ws, "place_sell_to_close",
                        lambda occ, price: sells.append((occ, price)))
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    positions = [  # only the long leg remains
        {"symbol": "AAL260612P00012500", "asset_class": "us_option", "qty": "1"},
    ]
    ws._handle_orphan_leg(state, "AAL", positions)
    assert sells == [("AAL260612P00012500", 0.04)]  # bid, not the 0.17 mid
    assert "AAL" not in state  # state cleared after the close


def test_orphan_short_closes_at_ask_not_mid(monkeypatch):
    """Long gone, short present → BTC the short at the ASK (marketable)."""
    state = _orphan_state()
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ: {"bid": 0.10, "ask": 0.40})  # mid 0.25
    buys = []
    monkeypatch.setattr(ws, "place_buy_to_close",
                        lambda occ, price: buys.append((occ, price)))
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    positions = [  # only the short leg remains
        {"symbol": "AAL260612P00013500", "asset_class": "us_option", "qty": "-1"},
    ]
    ws._handle_orphan_leg(state, "AAL", positions)
    assert buys == [("AAL260612P00013500", 0.40)]  # ask, not the 0.25 mid
    assert "AAL" not in state


# ── F. PDT-block detection + quiet routing (2026-06-03) ──────────────────────

def test_is_pdt_denied_matches_code_and_phrase():
    body = ('HTTPError: 403 Client Error: Forbidden for url: ... — '
            '{"code":40310100,"message":"trade denied due to pattern day trading protection"}')
    assert ws.is_pdt_denied(body)
    assert ws.is_pdt_denied("Pattern Day Trading protection")
    assert not ws.is_pdt_denied('{"code":40310000,"message":"insufficient buying power"}')
    assert not ws.is_pdt_denied("")
    assert not ws.is_pdt_denied(None)


class _PDTResp:
    text = ('{"code":40310100,"message":"trade denied due to pattern day '
            'trading protection"}')


class _PDTError(Exception):
    response = _PDTResp()


def test_pdt_close_failure_routes_to_actions_not_errors(monkeypatch):
    monkeypatch.setattr(ws, "ERRORS_CH", "errors")
    monkeypatch.setattr(ws, "ACTIONS_CH", "actions")
    monkeypatch.setattr(ws, "MODE", "manual")
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ: {"bid": 1.0, "ask": 1.2})

    def _raise_pdt(occ, price):
        raise _PDTError("403 Client Error: Forbidden for url: .../orders")
    monkeypatch.setattr(ws, "place_buy_to_close", _raise_pdt)

    embeds = []
    events = []
    monkeypatch.setattr(ws, "send_embed",
                        lambda channel, title, **kw: embeds.append((channel, title)))
    monkeypatch.setattr(ws, "log_event",
                        lambda *a, **kw: events.append((a, kw)))
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    sym_state = {
        "spread_type": "put_credit",
        "short_leg": {"occ": "NVDA260618P00218000", "entry_premium": 6.0, "qty": 1},
        "long_leg":  {"occ": "NVDA260618P00213000", "entry_premium": 4.0, "qty": 1},
    }
    ok = ws._close_spread_legs_individually(sym_state)

    assert ok is False                              # close did not go through
    assert len(embeds) == 1
    channel, title = embeds[0]
    assert channel == "actions"                     # quiet — NOT errors
    assert "PDT" in title
    # structured event is a "skipped" PDT block, not a hard failure
    assert events and events[0][0][2] == "spread_close_pdt_blocked"


# ── G. Centralized PDT-quieting at wheel close boundaries (2026-06-03) ───────

def test_report_pdt_quietly_routes_to_actions_and_returns_true(monkeypatch):
    monkeypatch.setattr(ws, "ACTIONS_CH", "actions")
    monkeypatch.setattr(ws, "ERRORS_CH", "errors")
    monkeypatch.setattr(ws, "MODE", "manual")
    embeds, events = [], []
    monkeypatch.setattr(ws, "send_embed",
                        lambda ch, title, **kw: embeds.append((ch, title)))
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: events.append((a, kw)))

    pdt = '... — {"code":40310100,"message":"trade denied due to pattern day trading protection"}'
    handled = ws.report_pdt_quietly("NVDA", pdt, "Wheel action")
    assert handled is True
    assert embeds and embeds[0][0] == "actions"          # quiet, not errors
    assert "PDT" in embeds[0][1]
    assert events and events[0][0][2] == "pdt_blocked"


def test_report_pdt_quietly_passes_through_non_pdt(monkeypatch):
    monkeypatch.setattr(ws, "ACTIONS_CH", "actions")
    sent = []
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: sent.append(a))
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    # a genuine error must NOT be swallowed — caller still emits its #errors embed
    assert ws.report_pdt_quietly("BAC", '{"code":40310000,"message":"insufficient buying power"}',
                                 "Wheel action") is False
    assert sent == []
