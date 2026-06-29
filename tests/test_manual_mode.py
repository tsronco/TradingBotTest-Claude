"""Tests for manual-mode-specific behaviour in strategy.py and wheel_strategy.py.

Manual mode is the third paper account: the user opens trades by hand, and
the bot manages them (trail/ladder/stop on stocks, 50% close on existing
puts, covered call sale on assignment) but never opens new puts itself.

Coverage here:
  - wheel _sell_new_put is a no-op under wheel_skip_new_puts
  - strategy._scaled_ladders scales TSLA's 8/12/20 ratios to other position sizes
  - strategy._manual_seed_state seeds correctly from an Alpaca position dict
  - wheel _parse_occ round-trips OCC option symbols
  - wheel _discover_wheel_state collects underlyings from positions
"""
import pytest

import config
import strategy
import wheel_strategy


@pytest.fixture(autouse=True)
def _set_manual_env(monkeypatch):
    monkeypatch.setenv("ALPACA_MANUAL_API_KEY", "manual-fake-key")
    monkeypatch.setenv("ALPACA_MANUAL_API_SECRET", "manual-fake-secret")
    monkeypatch.setenv("ALPACA_MANUAL_BASE_URL", "https://paper-api.alpaca.markets/v2")
    yield
    # Restore default mode for any later tests in the suite
    wheel_strategy.apply_mode(config.DEFAULT_MODE)
    strategy.apply_mode(config.DEFAULT_MODE)


# ── wheel: _sell_new_put gated by WHEEL_SKIP_NEW_PUTS ────────────────────


def test_wheel_skip_new_puts_no_ops_in_manual(fresh_symbol_state, monkeypatch):
    """In manual mode, _sell_new_put should never place an order — it logs
    a heartbeat and returns. Conservative still places orders normally."""
    wheel_strategy.apply_mode("manual")

    placed = []
    monkeypatch.setattr(wheel_strategy, "place_sell_to_open",
                        lambda *a, **kw: placed.append((a, kw)))
    # The function checks WHEEL_SKIP_NEW_PUTS BEFORE doing anything else,
    # so we don't even need to mock find_best_contract / round_strike etc.

    sym_state = fresh_symbol_state
    account = {"cash": "10000", "options_buying_power": "10000"}
    wheel_strategy._sell_new_put("TSLA", sym_state, stock_price=200.0, account=account)

    assert placed == [], "manual mode placed an order — WHEEL_SKIP_NEW_PUTS gate failed"
    assert "manual" in (sym_state.get("last_action") or "").lower()


def test_wheel_skip_new_puts_off_attempts_sell(fresh_symbol_state, monkeypatch):
    """With WHEEL_SKIP_NEW_PUTS off, _sell_new_put must proceed past the gate.

    (Both surviving modes — manual + live — keep WHEEL_SKIP_NEW_PUTS on, so
    drive the flag off directly to exercise the gate's negative case; this is
    the path the retired conservative/aggressive accounts used to take.)"""
    wheel_strategy.apply_mode("manual")
    monkeypatch.setattr(wheel_strategy, "WHEEL_SKIP_NEW_PUTS", False)
    # Don't fully exercise the path — just verify the gate doesn't fire.
    # We assert the function tries to look at options_buying_power, which
    # only happens once past the manual-mode early return.
    monkeypatch.setattr(wheel_strategy, "round_strike", lambda *a: 0.0)
    bp_reads = []
    real_get_account = wheel_strategy.get_account
    def spying_get_account():
        bp_reads.append(True)
        return real_get_account()
    monkeypatch.setattr(wheel_strategy, "get_account", spying_get_account)

    sym_state = fresh_symbol_state
    account = {"cash": "100000", "options_buying_power": "100000"}
    # We expect this to attempt a fresh BP fetch (which the manual gate
    # would have skipped). It may fail downstream — we don't care here.
    try:
        wheel_strategy._sell_new_put("TSLA", sym_state, stock_price=200.0, account=account)
    except Exception:
        pass
    assert bp_reads, "skip-off mode short-circuited like manual — gate misfiring"


# ── strategy: ladder scaling ──────────────────────────────────────────────


def test_scaled_ladders_matches_tsla_ratios_at_qty_10():
    """TSLA's 8/12/20 ladder is the multipliers' golden case (qty=10)."""
    ladders = strategy._scaled_ladders(10)
    qtys = [ldr["qty"] for ldr in ladders]
    assert qtys == [8, 12, 20], "qty=10 should reproduce TSLA's hand-tuned ladder"


def test_scaled_ladders_scales_down_for_small_position():
    """5 shares → 4/6/10. 1 share → 1/1/2 (rounding to ≥1)."""
    assert [l["qty"] for l in strategy._scaled_ladders(5)] == [4, 6, 10]
    assert [l["qty"] for l in strategy._scaled_ladders(1)] == [1, 1, 2]


def test_scaled_ladders_preserves_drop_pcts():
    """Drop percentages stay 15/25/40 regardless of size."""
    drops = [ldr["drop"] for ldr in strategy._scaled_ladders(7)]
    assert drops == [0.15, 0.25, 0.40]


# ── strategy: seeding state from an Alpaca position ──────────────────────


def test_manual_seed_state_uses_position_avg_cost_as_entry():
    pos = {"avg_entry_price": "243.55", "qty": "20"}
    state = strategy._manual_seed_state("TSLA", pos)
    assert state["entry_price"] == 243.55
    assert state["initial_qty"] == 20
    assert state["avg_cost"] == 243.55
    assert state["position_qty"] == 20
    assert state["total_cost"] == round(243.55 * 20, 2)
    assert state["high_water_mark"] == 243.55
    assert state["trailing_active"] is False
    assert state["ladder_done"] == [False, False, False]
    # Stop = avg_cost * (1 - STOP_PCT) = 243.55 * 0.90 = 219.20 (rounded)
    assert state["stop_price"] == round(243.55 * 0.90, 2)


# ── wheel: OCC parser round-trip ──────────────────────────────────────────


@pytest.mark.parametrize("symbol,expected", [
    # TSLA 2026-05-16 put $250
    ("TSLA260516P00250000", ("TSLA", "put", 250.0)),
    # AAPL 2026-06-20 call $200.50
    ("AAPL260620C00200500", ("AAPL", "call", 200.5)),
    # MARA 2026-04-25 put $15.50
    ("MARA260425P00015500", ("MARA", "put", 15.5)),
])
def test_parse_occ_extracts_ticker_side_strike(symbol, expected):
    parsed = wheel_strategy._parse_occ(symbol)
    assert parsed is not None
    ticker, side, strike, _expiry = parsed
    assert (ticker, side, strike) == expected


def test_parse_occ_returns_none_on_garbage():
    assert wheel_strategy._parse_occ("not-an-occ-symbol") is None
    assert wheel_strategy._parse_occ("TSLA") is None  # no digit suffix
    assert wheel_strategy._parse_occ("TSLA260516Q00250000") is None  # bad side


# ── wheel: auto-discovery from positions ──────────────────────────────────


def test_discover_wheel_state_includes_short_put_underlyings(monkeypatch):
    """A short put on AAPL should add AAPL to the discovered set and seed state."""
    wheel_strategy.apply_mode("manual")
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {
            "symbol": "AAPL260620P00200000",
            "asset_class": "us_option",
            "qty": "-1",
            "avg_entry_price": "-3.50",  # premium received per share
        },
    ])
    monkeypatch.setattr(wheel_strategy, "get_stock_position", lambda s: None)
    state: dict = {}
    discovered = wheel_strategy._discover_wheel_state(state)
    assert "AAPL" in discovered
    assert state["AAPL"]["current_contract"] == "AAPL260620P00200000"
    assert state["AAPL"]["contract_type"] == "put"
    assert state["AAPL"]["contract_strike"] == 200.0
    assert state["AAPL"]["stage"] == 1
    assert state["AAPL"]["contract_entry_price"] == 3.50
    assert state["AAPL"]["contract_qty"] == 1


def test_discover_wheel_state_includes_stocks_with_100_plus_shares(monkeypatch):
    """A 100-share TSLA holding (Stage 2 candidate) belongs in the discovered set."""
    wheel_strategy.apply_mode("manual")
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "TSLA", "asset_class": "us_equity", "qty": "150",
         "avg_entry_price": "240.00"},
        {"symbol": "AAPL", "asset_class": "us_equity", "qty": "5",
         "avg_entry_price": "180.00"},  # too few for Stage 2
    ])
    state: dict = {}
    discovered = wheel_strategy._discover_wheel_state(state)
    assert "TSLA" in discovered
    assert "AAPL" not in discovered, "5 shares is below the 100-share Stage 2 threshold"


def test_discover_wheel_state_long_options_ignored(monkeypatch):
    """Long options are managed by long_options_strategy.py, not the wheel."""
    wheel_strategy.apply_mode("manual")
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "NVDA260620C00500000", "asset_class": "us_option",
         "qty": "+3", "avg_entry_price": "5.20"},  # long call
    ])
    state: dict = {}
    discovered = wheel_strategy._discover_wheel_state(state)
    assert discovered == set(), "long options should not enter the wheel discovery set"


def test_discover_wheel_state_short_call_treated_as_stage_2(monkeypatch):
    """If the user manually pre-sold a CC, adopt it directly into Stage 2."""
    wheel_strategy.apply_mode("manual")
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "TSLA260620C00280000", "asset_class": "us_option",
         "qty": "-1", "avg_entry_price": "-2.50"},
    ])
    monkeypatch.setattr(wheel_strategy, "get_stock_position", lambda s: {
        "qty": "100", "avg_entry_price": "250.00",
    })
    state: dict = {}
    wheel_strategy._discover_wheel_state(state)
    assert state["TSLA"]["stage"] == 2
    assert state["TSLA"]["shares_qty"] == 100
    assert state["TSLA"]["cost_basis_per_share"] == 250.0


# ── PDT (Pattern Day Trading) block detection — strategy.py exits ────────────
# A sub-$25k margin account (manual $10k; sm500/sm1000/sm2000) that hits the
# day-trade limit gets every closing order denied, including stock exits via
# DELETE /positions/{sym}. Those must be quieted to #actions, not #errors.

def test_strategy_is_pdt_denied_matches_code_and_phrase():
    pdt = ('HTTPError: 403 Client Error: Forbidden for url: '
           '.../v2/positions/SNAP — '
           '{"code":40310100,"message":"trade denied due to pattern day trading protection"}')
    assert strategy.is_pdt_denied(pdt)
    assert strategy.is_pdt_denied("Pattern Day Trading protection")
    assert not strategy.is_pdt_denied('{"code":40310000,"message":"insufficient buying power"}')
    assert not strategy.is_pdt_denied("")
    assert not strategy.is_pdt_denied(None)


def test_strategy_alpaca_err_detail_appends_response_body():
    class _Resp:
        text = '{"code":40310100,"message":"trade denied due to pattern day trading protection"}'

    class _Err(Exception):
        response = _Resp()

    detail = strategy.alpaca_err_detail(_Err("403 Client Error: Forbidden"))
    assert "40310100" in detail
    assert strategy.is_pdt_denied(detail)


# ── Covered-call collateral: strategy.py manages only freely-sellable shares ──
# SNAP held 110 shares with 100 locked as covered-call collateral (wheel stage
# 2); the manual stop tried to liquidate all 110 (DELETE /positions) and Alpaca
# rejected 40310000 "insufficient qty (requested 110, available 10)", crashing
# the cycle into #errors every tick (2026-06-03).

def test_available_qty_excludes_options_collateral():
    snap = {"symbol": "SNAP", "qty": "110", "qty_available": "10",
            "avg_entry_price": "6.00"}
    assert strategy._available_qty(snap) == 10          # not 110


def test_available_qty_falls_back_to_qty_when_field_absent():
    assert strategy._available_qty({"qty": "42", "avg_entry_price": "5"}) == 42


def test_manual_seed_uses_available_not_total_qty():
    snap = {"symbol": "SNAP", "qty": "110", "qty_available": "10",
            "avg_entry_price": "6.00"}
    seeded = strategy._manual_seed_state("SNAP", snap)
    assert seeded["position_qty"] == 10                 # manages free shares only
    assert seeded["initial_qty"] == 10


def test_manual_stop_sells_only_free_qty_not_full_liquidation(monkeypatch):
    # 10 free shares (100 locked for a CC); stop fires below the stop price.
    sym_state = strategy._manual_seed_state(
        "SNAP", {"symbol": "SNAP", "qty": "110", "qty_available": "10",
                 "avg_entry_price": "6.00"})
    monkeypatch.setattr(strategy, "get_latest_price", lambda s: 5.00)  # below stop 5.40
    monkeypatch.setattr(strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(strategy, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(strategy, "log", lambda *a, **kw: None)

    calls = {"orders": [], "close_all": 0}
    monkeypatch.setattr(strategy, "place_order",
                        lambda sym, qty, side, **kw: calls["orders"].append((sym, qty, side)))
    def _boom(sym):
        calls["close_all"] += 1
    monkeypatch.setattr(strategy, "close_all", _boom)

    strategy._manual_run_symbol("SNAP", sym_state, 10, 6.00)
    assert calls["close_all"] == 0                       # no full-position liquidation
    assert calls["orders"] == [("SNAP", 10, "sell")]     # bounded sell of free shares


# ── Excluded symbols: bot hands a position back to manual control ───────────
# A symbol in config.MODES[mode]["excluded_symbols"] must be skipped by BOTH
# wheel_strategy (no covered-call sale on assignment, no put mgmt) and
# strategy.py (no trail/ladder/stop). Used to let the user exit a position by
# hand without the bot re-covering or laddering into it. SNAP added 2026-06-19:
# assigned 100 shares underwater, a pending CC is being cancelled, and the bot
# must not sell another one.

def test_excluded_symbols_helper_normalizes_and_defaults():
    excl = config.excluded_symbols("manual")
    assert "SNAP" in excl
    # set is already uppercased/normalized
    assert excl == {s.upper() for s in excl}
    # modes that don't opt in get an empty set — unaffected
    assert config.excluded_symbols("live") == set()


def test_apply_mode_sets_excluded_symbols_on_both_scripts():
    wheel_strategy.apply_mode("manual")
    assert "SNAP" in wheel_strategy.EXCLUDED_SYMBOLS
    strategy.apply_mode("manual")
    assert "SNAP" in strategy.EXCLUDED_SYMBOLS
    # Live carries none.
    wheel_strategy.apply_mode("live")
    assert wheel_strategy.EXCLUDED_SYMBOLS == set()
    strategy.apply_mode("live")
    assert strategy.EXCLUDED_SYMBOLS == set()


def test_wheel_skips_excluded_symbol_no_covered_call(monkeypatch, tmp_path):
    """run_wheel must not manage an excluded symbol even when discovery sees
    it as a held Stage 2 position (which would otherwise sell a covered call)."""
    import json
    wheel_strategy.apply_mode("manual")
    assert "SNAP" in wheel_strategy.EXCLUDED_SYMBOLS

    def _stage2():
        s = wheel_strategy._empty_symbol_state()
        s["stage"] = 2
        s["shares_qty"] = 100
        s["cost_basis_per_share"] = 10.0
        return s

    state = {"_meta": {}, "SNAP": _stage2(), "TSLA": _stage2()}
    state_file = tmp_path / "wheel_state_manual.json"
    state_file.write_text(json.dumps(state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))
    monkeypatch.setattr(wheel_strategy, "is_market_open", lambda: True)
    monkeypatch.setattr(wheel_strategy, "get_account",
                        lambda: {"cash": "10000", "options_buying_power": "10000",
                                 "portfolio_value": "10000"})
    # Discovery sees both names; the exclusion filter must drop SNAP.
    monkeypatch.setattr(wheel_strategy, "_discover_wheel_state",
                        lambda state: {"SNAP", "TSLA"})

    priced = []
    monkeypatch.setattr(wheel_strategy, "get_latest_price",
                        lambda sym: (priced.append(sym), 10.0)[1])
    handled = []
    monkeypatch.setattr(wheel_strategy, "handle_stage2",
                        lambda symbol, *a, **kw: handled.append(symbol))
    monkeypatch.setattr(wheel_strategy, "handle_stage1",
                        lambda symbol, *a, **kw: handled.append(symbol))

    wheel_strategy.run_wheel()

    assert "SNAP" not in handled, "bot must not manage excluded SNAP"
    assert "SNAP" not in priced, "bot must not even price excluded SNAP"
    assert "TSLA" in handled, "non-excluded symbols still managed"


def test_strategy_skips_excluded_symbol(monkeypatch, tmp_path):
    """run_one_cycle_manual must not seed or run an excluded symbol, but must
    still manage other held stocks."""
    import json
    strategy.apply_mode("manual")
    assert "SNAP" in strategy.EXCLUDED_SYMBOLS

    state_file = tmp_path / "strategy_state_manual.json"
    state_file.write_text(json.dumps({}))
    monkeypatch.setattr(strategy, "STATE_FILE", str(state_file))
    monkeypatch.setattr(strategy, "get_stock_positions", lambda: [
        {"symbol": "SNAP", "qty": "100", "avg_entry_price": "10.00"},
        {"symbol": "AAPL", "qty": "100", "avg_entry_price": "190.00"},
    ])
    monkeypatch.setattr(strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(strategy, "log_event", lambda *a, **kw: None)

    seeded = []
    monkeypatch.setattr(strategy, "_manual_seed_state",
                        lambda symbol, position: seeded.append(symbol) or
                        {"position_qty": 100, "initial_qty": 100, "entry_price": 1.0,
                         "stop_price": 0.9})
    ran = []
    monkeypatch.setattr(strategy, "_manual_run_symbol",
                        lambda symbol, *a, **kw: ran.append(symbol) or {"position_qty": 100})

    strategy.run_one_cycle_manual()

    assert "SNAP" not in seeded and "SNAP" not in ran, "bot must not manage excluded SNAP"
    assert "AAPL" in seeded and "AAPL" in ran, "non-excluded stocks still managed"
