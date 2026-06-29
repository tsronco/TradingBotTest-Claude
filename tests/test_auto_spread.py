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
    # max loss = (width - net_credit) * 100; pass iff <= equity * max_risk_pct
    # $1 wide, $0.10 credit on $500 @ 20%: (1.00-0.10)*100=90 <= 100 -> True
    assert ws.spread_passes_risk(1.0, 0.10, 500, 0.20) is True
    # same spread on $500 @ 15%: 90 <= 75 -> False (why sm500 was stuck)
    assert ws.spread_passes_risk(1.0, 0.10, 500, 0.15) is False
    # zero credit makes it gross-width again: $1 wide $1000 @ 0.10: 100 <= 100 -> True
    assert ws.spread_passes_risk(1.0, 0.0, 1000, 0.10) is True
    # net-of-credit is looser than gross: $1.20 wide, $0.30 credit, $1000 @ 0.10
    #   gross 120 > 100 (old: False) but net (1.20-0.30)*100=90 <= 100 -> True
    assert ws.spread_passes_risk(1.2, 0.30, 1000, 0.10) is True
    # over-wide still rejected: $2 wide, $0.05 credit, $1000 @ 0.15: 195 > 150 -> False
    assert ws.spread_passes_risk(2.0, 0.05, 1000, 0.15) is False


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


# ── Task 4.3: _open_spread_mleg multi-leg open primitive ─────────────────

def test_open_spread_mleg_builds_exact_body(monkeypatch):
    captured = {}

    def fake_api_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"id": "ord-spread-1"}

    monkeypatch.setattr(ws, "api_post", fake_api_post)

    ws._open_spread_mleg(
        short_occ="AAL260529P00012500",
        long_occ="AAL260529P00011500",
        qty=1,
        net_credit=0.25,
    )

    assert captured["path"] == "/orders"
    assert captured["body"] == {
        "order_class":   "mleg",
        "qty":           "1",
        "type":          "limit",
        "limit_price":   "-0.25",   # negative => net credit received
        "time_in_force": "day",
        "legs": [
            {"symbol": "AAL260529P00012500", "side": "sell",
             "ratio_qty": "1", "position_intent": "sell_to_open"},
            {"symbol": "AAL260529P00011500", "side": "buy",
             "ratio_qty": "1", "position_intent": "buy_to_open"},
        ],
    }


def test_open_spread_mleg_limit_is_negative_of_credit(monkeypatch):
    """A passed-in positive OR negative credit always yields a negative
    limit price (credit convention, mirroring the dashboard form)."""
    captured = {}
    monkeypatch.setattr(ws, "api_post",
                        lambda p, b: captured.update(body=b) or {"id": "x"})

    ws._open_spread_mleg("S260529P00010000", "L260529P00009000", 2, -0.42)
    assert captured["body"]["limit_price"] == "-0.42"
    assert captured["body"]["qty"] == "2"


# ── Task 4.4: _auto_open_spread orchestration + per-cycle wiring ──────────
import screener_core
import earnings as earnings_mod
import config


# The autonomous spread engine is config-driven and stays in the codebase.
# It used to be exercised through the sm1000 account's "Balanced" opener
# posture; that account was retired 2026-06-29. `manual` now carries the same
# opener params, so derive the engine-test cfg from manual and pin the few
# scalars that differed on sm1000 (lower account_floor / concurrency / opens
# per cycle, auto-open ON, the SM 2× credit stop) while dropping the
# manual-only management keys (delta targeting, ETF bypass, the manual
# tripwire) the opener/selection tests don't expect.
SM_CFG = dict(config.get_mode("manual"))
SM_CFG.update({
    "auto_open_spreads":       True,
    "account_floor":           300,
    "max_concurrent_spreads":  2,
    "max_opens_per_cycle":     1,
    "bp_switch_threshold":     5000,
    "spread_stop_credit_mult": 2.0,
})
for _k in ("short_put_target_delta", "wheelability_bypass_symbols",
           "spread_underlying_tripwire", "spread_tripwire_dte",
           "spread_tripwire_confirm_minutes"):
    SM_CFG.pop(_k, None)


def _contract(occ, strike, expiration="2026-06-12"):
    return {"symbol": occ, "strike_price": str(strike),
            "expiration_date": expiration}


def _wire_sm(monkeypatch, *, equity, options_bp,
             scored, earnings_within, contracts_by_strike, quotes,
             max_underlying_price=None):
    """Patch every external seam for an SM auto-open cycle.

    scored: {symbol: {"score": float, "price": float}} or {symbol: None}
    earnings_within: {symbol: bool}
    contracts_by_strike: {(symbol, strike): contract-dict}
    quotes: {occ: {"bid": .., "ask": ..}}
    """
    ws.AUTO_OPEN_SPREADS = True
    cfg = dict(SM_CFG)
    cfg["max_underlying_price"] = max_underlying_price
    # Default the R12 minimum-pool gate OFF for the shared harness — most tests
    # use tiny 1-2 name pools to isolate other behavior. The gate is exercised
    # explicitly by the dedicated R12 tests below.
    cfg["wheelability_min_pool"] = None

    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": str(equity),
                                 "options_buying_power": str(options_bp)})
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: sorted(scored.keys()))

    def fake_score(symbol, free_bp, **kw):
        return scored.get(symbol)
    monkeypatch.setattr(screener_core, "score_candidate", fake_score)

    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda sym, days: earnings_within.get(sym, False))

    def fake_find(underlying, opt_type, target_strike, dmin, dmax, exp_date=None):
        # nearest available strike for this underlying
        cands = {k[1]: v for k, v in contracts_by_strike.items()
                 if k[0] == underlying}
        if not cands:
            return None
        best = min(cands, key=lambda s: abs(s - target_strike))
        return cands[best]
    monkeypatch.setattr(ws, "find_best_contract", fake_find)

    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: quotes.get(occ))

    # Trend fetcher: return flat history so is_above_sma20 returns True
    # (all real prices in these tests are > 1.0, so synthetic flat 1.0 works)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [1.0] * 20)

    opened = []
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda s, l, qty, nc, limit_credit=None: opened.append(
                            {"short": s, "long": l, "qty": qty, "net_credit": nc,
                             "limit_credit": limit_credit})
                        or {"id": "ord-1"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)
    return cfg, opened


def test_auto_open_inert_when_flag_off(monkeypatch):
    """Gated off: AUTO_OPEN_SPREADS False -> immediate return, nothing
    touched. This is the cons/agg/manual/live isolation guarantee."""
    ws.AUTO_OPEN_SPREADS = False
    called = []
    monkeypatch.setattr(ws, "get_account",
                        lambda: called.append("acct") or {"equity": "1000"})
    state = {"_meta": {}}
    ws._auto_open_spread(state, {}, SM_CFG)
    assert called == [], "must not even call get_account when flag off"
    assert state == {"_meta": {}}


def test_auto_open_happy_path_opens_one_spread(monkeypatch):
    # CHEAP scores top; short ~10% OTM of $20 = $18, long one strike below = $17
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
        ("CHEAP", 16.0): _contract("CHEAP260612P00016000", 16.0),
    }
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.55, "ask": 0.65},  # short mid 0.60
        "CHEAP260612P00017000": {"bid": 0.20, "ask": 0.30},  # long mid 0.25; ratio 0.35/1.0=0.35 >= 0.33
        "CHEAP260612P00016000": {"bid": 0.18, "ask": 0.26},
    }
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0},
                "OTHER": {"score": 3.0, "price": 50.0}},
        earnings_within={},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)

    assert len(opened) == 1
    o = opened[0]
    assert o["short"] == "CHEAP260612P00018000"
    assert o["long"] == "CHEAP260612P00017000"   # narrowest $1 width
    # net credit = short mid - long mid = 0.60 - 0.25 = 0.35
    assert round(o["net_credit"], 2) == 0.35
    # state seeded as spread_active for handle_spread adoption
    assert state["CHEAP"]["stage"] == "spread_active"
    assert state["CHEAP"]["spread_type"] == "put_credit"
    assert state["CHEAP"]["short_leg"]["occ"] == "CHEAP260612P00018000"
    assert state["CHEAP"]["long_leg"]["occ"] == "CHEAP260612P00017000"
    assert state["CHEAP"]["width"] == 1.0
    assert round(state["CHEAP"]["net_credit"], 2) == 0.35
    # max_loss MUST be per-share (width - net_credit), matching
    # _adopt_spread's round(width - net_credit, 4). The old buggy
    # width*100 made the 50%-max-loss stop physically unreachable.
    # width 1.0, net_credit 0.35 -> round(1.0 - 0.35, 4) == 0.65
    assert state["CHEAP"]["max_loss"] == round(1.0 - 0.35, 4)
    assert state["CHEAP"]["max_loss"] == 0.65
    assert state["CHEAP"]["expiration"] == "2026-06-12"
    assert state["CHEAP"]["opened_at"] is not None


def test_auto_open_earnings_block_skips_to_next(monkeypatch):
    """Top symbol has earnings within window -> skipped; next-best (still
    in the >=90 percentile band) with clear earnings is opened instead.

    Percentile normalization (the plan's RESOLVED #1) means the 2nd-best
    only clears the 90 gate when the universe is large enough. Top two of
    an 11-name universe land at percentile 100 and 90 — both >= 90 — so
    the earnings-skip-to-next path is genuinely reachable here.
    """
    # 11 symbols: TOP (score 100, earnings-blocked) and NEXT (score 99,
    # clear) are the two highest; 9 fillers below keep percentiles spread
    # so NEXT lands at exactly the 90th percentile (index 9 of 0..10).
    scored = {"TOP": {"score": 100.0, "price": 20.0},
              "NEXT": {"score": 99.0, "price": 20.0}}
    for i in range(9):
        scored[f"F{i}"] = {"score": float(i + 1), "price": 20.0}
    contracts = {
        ("NEXT", 18.0): _contract("NEXT260612P00018000", 18.0),
        ("NEXT", 17.0): _contract("NEXT260612P00017000", 17.0),
    }
    quotes = {
        "NEXT260612P00018000": {"bid": 0.50, "ask": 0.60},   # short mid 0.55
        "NEXT260612P00017000": {"bid": 0.15, "ask": 0.25},   # long mid 0.20; ratio 0.35/1.0=0.35 >= 0.33
    }
    earnings = {s: False for s in scored}
    earnings["TOP"] = True
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1000, options_bp=2000,
        scored=scored,
        earnings_within=earnings,
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert len(opened) == 1
    assert opened[0]["short"] == "NEXT260612P00018000"
    assert "TOP" not in state
    assert state["NEXT"]["stage"] == "spread_active"


def test_auto_open_earnings_block_all_no_trade(monkeypatch):
    """Every scored symbol has earnings within window -> no order, logged
    as a normal event (NOT an exception)."""
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1000, options_bp=2000,
        scored={"AAA": {"score": 9.0, "price": 20.0},
                "BBB": {"score": 8.0, "price": 20.0}},
        earnings_within={"AAA": True, "BBB": True},
        contracts_by_strike={},
        quotes={},
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)  # no raise
    assert opened == []
    assert state == {"_meta": {}}


def test_auto_open_risk_cap_blocks_no_trade(monkeypatch):
    """sm1000-style: cheapest available width still exceeds net-of-credit risk
    cap -> no order; normal 'no trade within risk budget' outcome.

    sm1000 uses max_risk_pct_equity=0.15; equity=$500 => budget=$75.
    $1 wide spread with thin credit ($0.05/share):
      net max_loss = (1.00 - 0.05) * 100 = $95 > $75 -> blocked.
    """
    # short mid = (0.50+0.60)/2 = 0.55; long mid = (0.45+0.55)/2 = 0.50
    # -> net_credit = 0.55 - 0.50 = 0.05 on a $1.00-wide spread
    # net-of-credit max_loss = (1.00 - 0.05) * 100 = $95
    # sm1000 budget = $500 equity * 0.15 = $75 -> $95 > $75 -> blocked
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
    }
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.50, "ask": 0.60},  # short mid 0.55
        "CHEAP260612P00017000": {"bid": 0.45, "ask": 0.55},  # long mid 0.50; credit=0.05
    }
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=500, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert opened == []
    assert "CHEAP" not in state


def test_auto_open_concurrency_cap_returns_early(monkeypatch):
    """open_spreads >= max_concurrent_spreads -> return immediately,
    no scoring call."""
    scored_calls = []
    monkeypatch.setattr(ws, "AUTO_OPEN_SPREADS", True)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "2000", "options_buying_power": "2000"})
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: scored_calls.append("built") or ["X"])
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)
    # 3 active spreads already == cap (max_concurrent_spreads=3)
    state = {"_meta": {},
             "A": {"stage": "spread_active"},
             "B": {"stage": "spread_active"},
             "C": {"stage": "spread_active"}}
    ws._auto_open_spread(state, {}, SM_CFG)
    assert scored_calls == [], "must not build universe when at concurrency cap"


def test_auto_open_account_floor_returns_early(monkeypatch):
    """equity < account_floor ($300) -> return immediately, no scoring."""
    built = []
    monkeypatch.setattr(ws, "AUTO_OPEN_SPREADS", True)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "250", "options_buying_power": "250"})
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: built.append("x") or [])
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)
    state = {"_meta": {}}
    ws._auto_open_spread(state, {}, SM_CFG)
    assert built == [], "must not build universe below account floor"


def test_auto_open_sm500_universe_price_filter(monkeypatch):
    """With max_underlying_price=25, a $40 underlying is excluded from
    scoring even if it would otherwise score highest."""
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
    }
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.50, "ask": 0.60},   # short mid 0.55
        "CHEAP260612P00017000": {"bid": 0.15, "ask": 0.25},   # long mid 0.20; ratio 0.35/1.0=0.35 >= 0.33
    }
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1000, options_bp=2000,
        scored={"PRICEY": {"score": 9.9, "price": 40.0},   # excluded by filter
                "CHEAP": {"score": 5.0, "price": 20.0}},     # only eligible
        earnings_within={},
        contracts_by_strike=contracts,
        quotes=quotes,
        max_underlying_price=25,
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert len(opened) == 1
    assert opened[0]["short"] == "CHEAP260612P00018000"
    assert "PRICEY" not in state


def test_auto_open_max_one_per_cycle(monkeypatch):
    """Several candidates qualify (both in the >=90 band) -> at most ONE
    _open_spread_mleg call, and the highest-scoring one is chosen."""
    # 11-name universe: AAA (100) and BBB (90) both clear the 90 gate;
    # 9 fillers below. Both AAA and BBB have full contract+quote data, so
    # without the one-per-cycle guard the loop would open both.
    scored = {"AAA": {"score": 100.0, "price": 20.0},
              "BBB": {"score": 99.0, "price": 20.0}}
    for i in range(9):
        scored[f"F{i}"] = {"score": float(i + 1), "price": 20.0}
    contracts = {
        ("AAA", 18.0): _contract("AAA260612P00018000", 18.0),
        ("AAA", 17.0): _contract("AAA260612P00017000", 17.0),
        ("BBB", 18.0): _contract("BBB260612P00018000", 18.0),
        ("BBB", 17.0): _contract("BBB260612P00017000", 17.0),
    }
    quotes = {
        "AAA260612P00018000": {"bid": 0.50, "ask": 0.60},   # short mid 0.55
        "AAA260612P00017000": {"bid": 0.15, "ask": 0.25},   # long mid 0.20; ratio 0.35/1.0=0.35 >= 0.33
        "BBB260612P00018000": {"bid": 0.50, "ask": 0.60},
        "BBB260612P00017000": {"bid": 0.15, "ask": 0.25},
    }
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=2000, options_bp=2000,
        scored=scored,
        earnings_within={s: False for s in scored},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert len(opened) == 1, "max_opens_per_cycle is 1 — exactly one open"
    # the highest-scoring one (AAA) is the one opened
    assert opened[0]["short"] == "AAA260612P00018000"
    assert "BBB" not in state


# ── Minimum net-credit floor (M-1 correctness fix) ───────────────────────
# A thin/illiquid chain can give long_mid >= short_mid. net_credit == 0
# pins _compute_spread_pnl's profit_pct to 0.0 forever (the 50%-profit
# close trigger can never fire); net_credit < 0 is a DEBIT spread placed
# via the credit-convention order, with max_loss = width - net_credit
# blowing past the risk cap that only validated `width`. The floor must
# reject both BEFORE _open_spread_mleg, continuing to the next candidate.


def _capture_log_event(monkeypatch):
    """Re-patch ws.log_event (the _wire_sm no-op) to record calls."""
    events = []
    monkeypatch.setattr(
        ws, "log_event",
        lambda stream, script, action, **kw: events.append((action, kw)))
    return events


def test_auto_open_zero_credit_rejected_no_order(monkeypatch):
    """short_mid == long_mid -> net_credit 0.0 < floor 0.05. No
    _open_spread_mleg call, state untouched, skip is logged."""
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
    }
    # identical mids -> net_credit = round(0.50 - 0.50, 4) == 0.0
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.45, "ask": 0.55},  # mid 0.50
        "CHEAP260612P00017000": {"bid": 0.45, "ask": 0.55},  # mid 0.50
    }
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    events = _capture_log_event(monkeypatch)
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)

    assert opened == [], "zero-credit spread must NOT reach _open_spread_mleg"
    assert "CHEAP" not in state, "state must be untouched on a rejected spread"
    skips = [kw for action, kw in events
             if kw.get("notes") == "below_min_net_credit"]
    assert len(skips) == 1, "the sub-floor skip must be logged"
    assert skips[0]["symbol"] == "CHEAP"
    assert skips[0]["details"]["net_credit"] == 0.0


def test_auto_open_negative_credit_rejected_no_order(monkeypatch):
    """long_mid > short_mid -> net_credit < 0 (a debit spread via the
    credit-convention order). Rejected; nothing opened, skip logged."""
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
    }
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.20, "ask": 0.30},  # short mid 0.25
        "CHEAP260612P00017000": {"bid": 0.55, "ask": 0.65},  # long mid 0.60
    }
    # equity=1500 (not 1000) so the negative-credit spread's max_loss of
    # $135 = (1.0 - (-0.35)) * 100 still fits inside the post-hardening
    # max_risk_pct_equity=0.10 cap ($150). Without this, the spread is
    # rejected at the RISK gate before ever reaching the credit-floor
    # check this test asserts. The risk-cap tightening shipped in Task 4
    # of the SM PCS hardening; the test's intent (verify negative-credit
    # spreads log below_min_net_credit and don't open) is preserved.
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1500, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    events = _capture_log_event(monkeypatch)
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)

    assert opened == [], "negative-credit spread must NOT be placed"
    assert "CHEAP" not in state
    skips = [kw for action, kw in events
             if kw.get("notes") == "below_min_net_credit"]
    assert len(skips) == 1
    # net_credit = round(0.25 - 0.60, 4) == -0.35
    assert skips[0]["details"]["net_credit"] == round(0.25 - 0.60, 4)


def test_auto_open_net_credit_just_below_floor_rejected(monkeypatch):
    """Boundary: net_credit 0.04 (< 0.05 floor) -> rejected."""
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
    }
    # short mid 0.50, long mid 0.46 -> net_credit 0.04 (one cent under)
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.45, "ask": 0.55},  # mid 0.50
        "CHEAP260612P00017000": {"bid": 0.41, "ask": 0.51},  # mid 0.46
    }
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert opened == [], "net_credit 0.04 < 0.05 floor -> rejected"
    assert "CHEAP" not in state


def test_auto_open_executable_credit_at_floor_accepted(monkeypatch):
    """Boundary: EXECUTABLE credit (short_bid - long_ask) exactly 0.05
    (== floor, NOT < floor) -> accepted. Pins the >= side of the new
    executable-credit boundary."""
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
    }
    # exec credit = short_bid 0.55 - long_ask 0.50 = 0.05 (== floor)
    # mid net_credit = 0.56 - 0.49 = 0.07
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.55, "ask": 0.57},  # mid 0.56
        "CHEAP260612P00017000": {"bid": 0.48, "ask": 0.50},  # mid 0.49
    }
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    # mid net_credit 0.07 / width 1.0 = 0.07 ratio < default 0.33 gate.
    # This test isolates the absolute-floor mechanism (exec_credit == floor
    # boundary), not ratio quality. Disable the ratio gate explicitly so the
    # test exercises only what it documents.
    cfg["min_credit_to_width_pct"] = None
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert len(opened) == 1, "executable credit == 0.05 floor (not <) -> accepted"
    assert round(opened[0]["net_credit"], 4) == 0.07
    assert state["CHEAP"]["stage"] == "spread_active"
    assert round(state["CHEAP"]["net_credit"], 4) == 0.07


def test_auto_open_skips_when_executable_credit_below_floor(monkeypatch):
    """Regression (F sm500 2026-05-18): mid net_credit clears the floor
    but the spread can only transact at a much worse executable price.
    The opener must SKIP it (don't open spreads you can't exit near)."""
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
    }
    # mid net_credit = 0.50 - 0.45 = 0.05 (>= floor, would have opened
    # under the old rule) BUT exec credit = short_bid 0.45 - long_ask
    # 0.50 = -0.05 (< floor) -> skip.
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.45, "ask": 0.55},  # mid 0.50
        "CHEAP260612P00017000": {"bid": 0.40, "ask": 0.50},  # mid 0.45
    }
    cfg, opened = _wire_sm(
        monkeypatch,
        equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert opened == [], "wide/illiquid executable credit < floor -> no open"
    assert "CHEAP" not in state


def test_run_wheel_calls_auto_open_on_cold_start_empty_discover(monkeypatch, tmp_path):
    """COLD START (the real first-trade path): an SM account discovers
    ZERO symbols. run_wheel must STILL invoke _auto_open_spread exactly
    once AND persist via save_state before the no-op return — otherwise
    the opener can never place its first trade (chicken-and-egg: nothing
    to discover until the opener opens something)."""
    import json
    # manual carries the auto-open engine; its config flag is PDT-disabled, so
    # drive AUTO_OPEN_SPREADS on directly to exercise the run_wheel wiring.
    ws.apply_mode("manual")
    monkeypatch.setattr(ws, "AUTO_OPEN_SPREADS", True)

    state_file = tmp_path / "wheel_state_manual.json"
    state_file.write_text(json.dumps({"_meta": {}}))
    monkeypatch.setattr(ws, "STATE_FILE", str(state_file))
    monkeypatch.setattr(ws, "is_market_open", lambda: True)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "1000", "options_buying_power": "1000"})
    # EMPTY discover — the cold-start case the old test masked with {"ZZZ"}.
    monkeypatch.setattr(ws, "_discover_wheel_state", lambda s: set())

    called = []
    monkeypatch.setattr(ws, "_auto_open_spread",
                        lambda state, account, cfg: called.append(cfg["log_stream"]))
    saved = []
    monkeypatch.setattr(ws, "save_state", lambda state: saved.append(True))

    ws.run_wheel()
    assert called == ["manual"], (
        "run_wheel must call _auto_open_spread exactly once even when "
        "_discover_wheel_state returns an empty set (cold start)"
    )
    assert saved == [True], (
        "save_state must persist after the cold-start opener so the next "
        "cycle's _discover_wheel_state finds the seeded spread"
    )

    # restore default mode so later tests/imports see conservative
    ws.apply_mode(config.DEFAULT_MODE)


def test_run_wheel_calls_auto_open_when_flag_on(monkeypatch, tmp_path):
    """Per-cycle wiring (NON-EMPTY discover path): run_wheel invokes
    _auto_open_spread exactly once after the management passes when
    AUTO_OPEN_SPREADS is on (SM mode) and at least one symbol is
    discovered. Guards against double-invocation across the two hook
    sites (cold-start branch vs. end-of-cycle hook)."""
    import json
    ws.apply_mode("manual")
    monkeypatch.setattr(ws, "AUTO_OPEN_SPREADS", True)

    state_file = tmp_path / "wheel_state_manual.json"
    state_file.write_text(json.dumps({"_meta": {}}))
    monkeypatch.setattr(ws, "STATE_FILE", str(state_file))
    monkeypatch.setattr(ws, "is_market_open", lambda: True)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "1000", "options_buying_power": "1000"})

    called = []
    monkeypatch.setattr(ws, "_auto_open_spread",
                        lambda state, account, cfg: called.append(cfg["log_stream"]))
    # Non-empty discover -> cycle proceeds past the discover gate to the
    # end-of-cycle hook. Must run exactly once (NOT also via cold-start).
    monkeypatch.setattr(ws, "_discover_wheel_state", lambda s: {"ZZZ"})
    monkeypatch.setattr(ws, "get_latest_price", lambda sym: 10.0)
    monkeypatch.setattr(ws, "handle_stage1", lambda *a, **kw: None)

    ws.run_wheel()
    assert called == ["manual"], (
        "run_wheel must call _auto_open_spread exactly once on the "
        "non-empty path (no double-run across hook sites)"
    )

    # restore default mode so later tests/imports see the default
    ws.apply_mode(config.DEFAULT_MODE)


def test_run_wheel_skips_auto_open_when_flag_off(monkeypatch, tmp_path):
    """live (AUTO_OPEN_SPREADS off): the auto-open hook is never invoked."""
    import json
    ws.apply_mode("live")
    assert ws.AUTO_OPEN_SPREADS is False

    state_file = tmp_path / "wheel_state_live.json"
    state_file.write_text(json.dumps({"_meta": {}, "TSLA":
                                      ws._empty_symbol_state()}))
    monkeypatch.setattr(ws, "STATE_FILE", str(state_file))
    monkeypatch.setattr(ws, "is_market_open", lambda: True)
    # live auto-discovers from positions — mock discovery so no Alpaca call.
    monkeypatch.setattr(ws, "_discover_wheel_state", lambda s: {"TSLA"})
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "100000",
                                 "options_buying_power": "100000"})
    monkeypatch.setattr(ws, "get_latest_price", lambda sym: 250.0)
    monkeypatch.setattr(ws, "handle_stage1", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "handle_stage2", lambda *a, **kw: None)

    called = []
    monkeypatch.setattr(ws, "_auto_open_spread",
                        lambda *a, **kw: called.append("X"))
    ws.run_wheel()
    assert called == [], "auto-open must not fire when the flag is off"
    ws.apply_mode(config.DEFAULT_MODE)


def test_empty_spread_state_has_open_order_tracking_fields():
    ss = ws._empty_spread_state()
    assert ss["stage"] == "spread_active"
    assert ss["open_order_id"] is None
    assert ss["open_limit_credit"] is None


from datetime import datetime, timezone, timedelta


def test_spread_order_age_hours_parses_opened_at():
    three_h_ago = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat().replace("+00:00", "Z")
    assert abs(ws._spread_order_age_hours({"opened_at": three_h_ago}) - 3.0) < 0.05


def test_spread_order_age_hours_missing_or_bad_returns_zero():
    assert ws._spread_order_age_hours({}) == 0.0
    assert ws._spread_order_age_hours({"opened_at": None}) == 0.0
    assert ws._spread_order_age_hours({"opened_at": "not-a-date"}) == 0.0


def _ss_with_order(order_id="ord-x", opened_at=None):
    ss = ws._empty_spread_state()
    ss["open_order_id"] = order_id
    ss["opened_at"] = opened_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return ss


def test_resolve_pending_spread_no_order_id_is_gone():
    assert ws._resolve_pending_spread(ws._empty_spread_state()) == "gone"


def test_resolve_pending_spread_404_is_gone(monkeypatch):
    monkeypatch.setattr(ws, "get_order", lambda oid: None)
    assert ws._resolve_pending_spread(_ss_with_order()) == "gone"


def test_resolve_pending_spread_new_is_pending(monkeypatch):
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "new"})
    assert ws._resolve_pending_spread(_ss_with_order()) == "pending"


def test_resolve_pending_spread_partially_filled_is_pending(monkeypatch):
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "partially_filled"})
    assert ws._resolve_pending_spread(_ss_with_order()) == "pending"


def test_resolve_pending_spread_filled(monkeypatch):
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "filled"})
    assert ws._resolve_pending_spread(_ss_with_order()) == "filled"


def test_resolve_pending_spread_rejected_is_gone(monkeypatch):
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "rejected"})
    assert ws._resolve_pending_spread(_ss_with_order()) == "gone"


def test_resolve_pending_spread_stale_when_old(monkeypatch):
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "new"})
    monkeypatch.setattr(ws, "STALE_AFTER_HOURS", 2.0)
    old = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat().replace("+00:00", "Z")
    assert ws._resolve_pending_spread(_ss_with_order(opened_at=old)) == "stale"


def test_auto_open_records_open_order_id_in_state(monkeypatch):
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
        ("CHEAP", 16.0): _contract("CHEAP260612P00016000", 16.0),
    }
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.55, "ask": 0.65},   # short mid 0.60
        "CHEAP260612P00017000": {"bid": 0.20, "ask": 0.30},   # long mid 0.25; ratio 0.35/1.0=0.35 >= 0.33
        "CHEAP260612P00016000": {"bid": 0.18, "ask": 0.26},
    }
    cfg, opened = _wire_sm(
        monkeypatch, equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={}, contracts_by_strike=contracts, quotes=quotes,
    )
    # _wire_sm patches _open_spread_mleg to return {"id": "ord-1"}
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)

    assert state["CHEAP"]["open_order_id"] == "ord-1"


def test_open_spread_mleg_default_limit_unchanged(monkeypatch):
    """No limit_credit passed → old behavior (full mid). Keeps the four
    non-SM modes / direct callers byte-identical."""
    cap = {}
    monkeypatch.setattr(ws, "api_post",
                        lambda p, b: cap.update(body=b) or {"id": "x"})
    ws._open_spread_mleg("S260605P00014000", "L260605P00013000", 1, 0.25)
    assert cap["body"]["limit_price"] == "-0.25"


def test_open_spread_mleg_uses_marketable_limit_credit(monkeypatch):
    cap = {}
    monkeypatch.setattr(ws, "api_post",
                        lambda p, b: cap.update(body=b) or {"id": "x"})
    # recorded credit (mid) 0.25, but submit at marketable 0.10
    ws._open_spread_mleg("S260605P00014000", "L260605P00013000", 1, 0.25,
                         limit_credit=0.10)
    assert cap["body"]["limit_price"] == "-0.10"


def test_open_spread_mleg_limit_credit_floored_at_min(monkeypatch):
    cap = {}
    monkeypatch.setattr(ws, "api_post",
                        lambda p, b: cap.update(body=b) or {"id": "x"})
    ws._open_spread_mleg("S260605P00014000", "L260605P00013000", 1, 0.25,
                         limit_credit=-0.04)  # negative natural bid
    assert cap["body"]["limit_price"] == "-0.01"  # SPREAD_OPEN_MIN_LIMIT


def test_auto_open_submits_marketable_limit_not_full_mid(monkeypatch):
    """End-to-end: short mid 0.60 / long mid 0.25 → recorded net_credit
    0.35 (mid), but the order is placed at short_bid - long_ask = 0.55 - 0.30
    = 0.25 (marketable), capped at the 0.35 mid → limit_credit 0.25."""
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
        ("CHEAP", 16.0): _contract("CHEAP260612P00016000", 16.0),
    }
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.55, "ask": 0.65},   # short mid 0.60
        "CHEAP260612P00017000": {"bid": 0.20, "ask": 0.30},   # long mid 0.25; ratio 0.35/1.0=0.35 >= 0.33
        "CHEAP260612P00016000": {"bid": 0.18, "ask": 0.26},
    }
    ws.AUTO_OPEN_SPREADS = True
    cfg = dict(SM_CFG)
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate (tested separately)
    cfg["max_underlying_price"] = None
    # The opener reads the open-limit concession from module globals (set by
    # apply_mode), not the cfg dict. Pin them to the legacy full-cross posture
    # this test asserts (0.55 - 0.30 = 0.25 marketable), independent of which
    # mode is ambient. (concession 1.0 = full marketable cross.)
    monkeypatch.setattr(ws, "SPREAD_OPEN_CONCESSION_PCT", 1.0)
    monkeypatch.setattr(ws, "SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID", 0.0)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "1000", "options_buying_power": "2000"})
    import screener_core, earnings as earnings_mod
    monkeypatch.setattr(screener_core, "build_universe", lambda u, w: ["CHEAP"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda s, bp, **k: {"score": 9.0, "price": 20.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)

    def fake_find(u, t, ts, dmin, dmax, exp_date=None):
        cands = {k[1]: v for k, v in contracts.items() if k[0] == u}
        return cands[min(cands, key=lambda s: abs(s - ts))]
    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "get_option_quote", lambda occ, **_k: quotes.get(occ))
    # Trend fetcher: synthetic flat history
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [1.0] * 20)
    captured = {}
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda s, l, q, nc, limit_credit=None: captured.update(
                            net_credit=nc, limit_credit=limit_credit)
                        or {"id": "ord-1"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)

    assert round(captured["net_credit"], 2) == 0.35      # recorded = mid (0.60 - 0.25)
    assert round(captured["limit_credit"], 2) == 0.25    # 0.55 - 0.30 (marketable)
    assert round(state["CHEAP"]["net_credit"], 2) == 0.35
    assert round(state["CHEAP"]["open_limit_credit"], 2) == 0.25


def test_working_spread_order_exists_detects_leg(monkeypatch):
    monkeypatch.setattr(ws, "api_get", lambda p, params=None: [
        {"status": "new", "legs": [
            {"symbol": "CHEAP260612P00018000"},
            {"symbol": "CHEAP260612P00017000"}]},
    ])
    assert ws._working_spread_order_exists("CHEAP260612P00018000",
                                           "CHEAP260612P00017000") is True
    assert ws._working_spread_order_exists("OTHER260612P00010000",
                                           "OTHER260612P00009000") is False


def test_working_spread_order_exists_ignores_terminal(monkeypatch):
    monkeypatch.setattr(ws, "api_get", lambda p, params=None: [
        {"status": "filled", "legs": [{"symbol": "CHEAP260612P00018000"}]},
    ])
    assert ws._working_spread_order_exists("CHEAP260612P00018000",
                                           "CHEAP260612P00017000") is False


def test_working_spread_order_exists_api_failure_is_false(monkeypatch):
    def boom(p, params=None):
        raise RuntimeError("alpaca down")
    monkeypatch.setattr(ws, "api_get", boom)
    # Defensive: a failed lookup must not block trading forever.
    assert ws._working_spread_order_exists("A", "B") is False


def test_auto_open_skips_symbol_with_existing_working_order(monkeypatch):
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
        ("CHEAP", 16.0): _contract("CHEAP260612P00016000", 16.0),
    }
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.55, "ask": 0.65},
        "CHEAP260612P00017000": {"bid": 0.30, "ask": 0.40},
        "CHEAP260612P00016000": {"bid": 0.18, "ask": 0.26},
    }
    cfg, opened = _wire_sm(
        monkeypatch, equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0}},
        earnings_within={}, contracts_by_strike=contracts, quotes=quotes,
    )
    monkeypatch.setattr(ws, "_working_spread_order_exists",
                        lambda s, l: True)
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)

    assert opened == [], "must not place a duplicate when a working order exists"
    assert "CHEAP" not in state


def test_spread_embed_fields():
    from datetime import date, timedelta
    exp = (date.today() + timedelta(days=18)).isoformat()
    f = ws._spread_embed_fields(
        short_strike=14.0, long_strike=13.0, width=1.0,
        net_credit=0.10, max_loss=0.91, expiration=exp,
    )
    assert isinstance(f, list) and len(f) == 6
    assert all(set(d) == {"name", "value", "inline"} for d in f)
    assert all(d["inline"] is True for d in f)
    names = [d["name"] for d in f]
    assert names == ["Short put", "Long put", "Width",
                     "Net credit", "Max loss", "Expires"]
    by = {d["name"]: d["value"] for d in f}
    assert by["Short put"] == "$14.00"
    assert by["Long put"] == "$13.00"
    assert by["Width"] == "$1.00"
    assert by["Net credit"] == "$0.10/sh\n($10.00)"
    assert by["Max loss"] == "$0.91/sh\n($91.00)"
    assert by["Expires"] == f"{exp}\n(18d)"


# ── Task 3: get_recent_daily_closes (Alpaca bars fetcher) ────────────────


def test_get_recent_daily_closes_returns_list_of_floats(monkeypatch):
    sample = {
        "bars": [
            {"c": 10.10}, {"c": 10.20}, {"c": 10.30}, {"c": 10.40},
            {"c": 10.50}, {"c": 10.60}, {"c": 10.70}, {"c": 10.80},
            {"c": 10.90}, {"c": 11.00}, {"c": 11.10}, {"c": 11.20},
            {"c": 11.30}, {"c": 11.40}, {"c": 11.50}, {"c": 11.60},
            {"c": 11.70}, {"c": 11.80}, {"c": 11.90}, {"c": 12.00},
        ]
    }
    class FakeResp:
        status_code = 200
        def json(self): return sample
    monkeypatch.setattr(ws, "_alpaca_request", lambda *a, **kw: FakeResp())
    closes = ws.get_recent_daily_closes("AMD", n=20)
    assert closes == [b["c"] for b in sample["bars"]]


def test_get_recent_daily_closes_empty_on_http_error(monkeypatch):
    class FakeResp:
        status_code = 500
        def json(self): return {}
    monkeypatch.setattr(ws, "_alpaca_request", lambda *a, **kw: FakeResp())
    assert ws.get_recent_daily_closes("AMD", n=20) == []


def test_get_recent_daily_closes_empty_on_exception(monkeypatch):
    def boom(*a, **kw): raise RuntimeError("net")
    monkeypatch.setattr(ws, "_alpaca_request", boom)
    assert ws.get_recent_daily_closes("AMD", n=20) == []


# ── Task 9: credit_ratio_passes gate in _auto_open_spread ──────────────────


def test_credit_to_width_gate_accepts_at_or_above_ratio():
    assert ws.credit_ratio_passes(net_credit=0.33, width=1.0, min_ratio=0.33) is True
    assert ws.credit_ratio_passes(net_credit=0.40, width=1.0, min_ratio=0.33) is True
    assert ws.credit_ratio_passes(net_credit=1.50, width=3.0, min_ratio=0.40) is True  # 0.50 ratio


def test_credit_to_width_gate_rejects_below_ratio():
    assert ws.credit_ratio_passes(net_credit=0.32, width=1.0, min_ratio=0.33) is False
    assert ws.credit_ratio_passes(net_credit=0.10, width=1.0, min_ratio=0.33) is False
    assert ws.credit_ratio_passes(net_credit=0.20, width=1.0, min_ratio=0.40) is False  # Conservative
    # Degenerate width (would div-by-zero) → reject
    assert ws.credit_ratio_passes(net_credit=1.0, width=0.0, min_ratio=0.33) is False


# ── Task 10: pick_best_ratio_width selector in _auto_open_spread ──────────


def test_pick_best_ratio_width_among_candidates():
    """Given multiple acceptable widths, pick the one with the highest
    credit/width ratio — NOT the narrowest."""
    candidates = [
        # narrowest: $1 wide, $0.20 credit → ratio 0.20
        {"width": 1.0, "net_credit": 0.20, "tag": "narrow"},
        # middle:    $2 wide, $0.70 credit → ratio 0.35
        {"width": 2.0, "net_credit": 0.70, "tag": "best"},
        # wider:     $3 wide, $0.60 credit → ratio 0.20
        {"width": 3.0, "net_credit": 0.60, "tag": "wide"},
    ]
    chosen = ws.pick_best_ratio_width(candidates)
    assert chosen["tag"] == "best"


def test_pick_best_ratio_width_empty_returns_none():
    assert ws.pick_best_ratio_width([]) is None


def test_pick_best_ratio_width_singleton_returns_it():
    c = {"width": 1.0, "net_credit": 0.40}
    assert ws.pick_best_ratio_width([c]) is c


# ── Task 11: trend-filter gate ────────────────────────────────────────────

def test_auto_open_spread_skips_symbols_below_sma20(monkeypatch):
    """When trend_filter is True, a candidate below its SMA20 must be
    skipped — even if all other gates pass."""
    ws.AUTO_OPEN_SPREADS = True
    cfg = dict(SM_CFG)
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate
    cfg["trend_filter"] = True

    state = {"_meta": {}}
    account = {"options_buying_power": 1000, "cash": 1000, "equity": 1000}

    monkeypatch.setattr(ws, "get_account", lambda: account)
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, a: ["AMD"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda *a, **kw: {"score": 9.0, "price": 100.0})
    monkeypatch.setattr(ws, "normalize_scores",
                        lambda raw: {"AMD": 99.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)

    # SMA20 helper returns False → below 20-day SMA
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [110.0] * 20)  # avg 110, current price 100 → below

    opened = []
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda *a, **kw: opened.append({"opened": True}) or "ORDER_ID")
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws._auto_open_spread(state, account, cfg)
    assert opened == []  # trend gate blocked it


def test_auto_open_spread_proceeds_above_sma20(monkeypatch):
    """Candidate above SMA20 makes it past the trend gate. (Other gates
    may block downstream — we only verify the trend gate doesn't.)"""
    ws.AUTO_OPEN_SPREADS = True
    cfg = dict(SM_CFG)
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate
    cfg["trend_filter"] = True

    state = {"_meta": {}}
    account = {"options_buying_power": 1000, "cash": 1000, "equity": 1000}

    monkeypatch.setattr(ws, "get_account", lambda: account)
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, a: ["AMD"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda *a, **kw: {"score": 9.0, "price": 100.0})
    monkeypatch.setattr(ws, "normalize_scores",
                        lambda raw: {"AMD": 99.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)

    # SMA20 returns True → above 20-day SMA → trend gate passes
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [90.0] * 20)  # avg 90, price 100 → above

    # find_best_contract returns None to terminate downstream cleanly
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda *a, **kw: None)

    trend_check_reached = {"hit": False}
    real_is_above = screener_core.is_above_sma20
    def spy_is_above(sym, price, fetch):
        trend_check_reached["hit"] = True
        return real_is_above(sym, price, fetch)
    monkeypatch.setattr(screener_core, "is_above_sma20", spy_is_above)

    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws._auto_open_spread(state, account, cfg)
    assert trend_check_reached["hit"] is True


# ── Delta-target short-leg selection + ETF wheelability bypass (2026-05-22) ─
#
# Two changes to _auto_open_spread on manual mode:
#   1. When cfg["short_put_target_delta"] is set, the short put is selected
#      by closest delta (find_contract_by_delta) instead of by closest
#      strike to price*(1-otm_pct).
#   2. Symbols in cfg["wheelability_bypass_symbols"] skip the percentile
#      floor and proceed to construction (all other gates still apply).
#
# SM/cons/agg/live modes leave these unset → byte-identical legacy behavior.


def test_parse_occ_strike_expiry_extracts_correctly():
    """OCC parse pulls strike + expiration in the QQQ format."""
    s, e = ws._parse_occ_strike_expiry("QQQ260618P00702000")
    assert s == 702.0
    assert e == "2026-06-18"


def test_parse_occ_strike_expiry_handles_long_underlying():
    """SPY too — verify multi-letter prefix + sub-dollar strike."""
    s, e = ws._parse_occ_strike_expiry("SPY260605P00540500")
    assert s == 540.5
    assert e == "2026-06-05"


def test_parse_occ_strike_expiry_rejects_garbage():
    """Malformed OCC returns (None, None) — fail-closed, no exception."""
    s, e = ws._parse_occ_strike_expiry("not-an-occ")
    assert s is None and e is None


def test_find_contract_by_delta_picks_closest(monkeypatch):
    """Given a chain snapshot, picks the contract whose Δ is nearest the
    target. Verifies the snapshot-endpoint path (greeks in one shot) and
    the closest-delta tiebreak."""
    chain = {
        "QQQ260618P00694000": {"greeks": {"delta": -0.249}},
        "QQQ260618P00702000": {"greeks": {"delta": -0.307}},
        "QQQ260618P00711000": {"greeks": {"delta": -0.382}},
        "QQQ260618P00715000": {"greeks": {"delta": -0.418}},
        "QQQ260618P00720000": {"greeks": {"delta": -0.467}},
    }
    class FakeResp:
        def raise_for_status(self): pass
        def json(self): return {"snapshots": chain}
    monkeypatch.setattr(ws, "_alpaca_request", lambda *a, **kw: FakeResp())

    c = ws.find_contract_by_delta("QQQ", "put", -0.40, 14, 28)
    # Δ -0.418 is closest to -0.40
    assert c is not None
    assert c["symbol"] == "QQQ260618P00715000"
    assert float(c["strike_price"]) == 715.0
    assert c["expiration_date"] == "2026-06-18"


def test_find_contract_by_delta_skips_entries_missing_greeks(monkeypatch):
    """Some snapshots lag greek computation — those entries must be skipped,
    not blow up the picker."""
    chain = {
        "QQQ260618P00702000": {"greeks": None},  # missing entirely
        "QQQ260618P00715000": {"greeks": {"delta": -0.418}},
        "QQQ260618P00720000": {},  # no greeks key at all
    }
    class FakeResp:
        def raise_for_status(self): pass
        def json(self): return {"snapshots": chain}
    monkeypatch.setattr(ws, "_alpaca_request", lambda *a, **kw: FakeResp())

    c = ws.find_contract_by_delta("QQQ", "put", -0.40, 14, 28)
    assert c is not None
    assert c["symbol"] == "QQQ260618P00715000"


def test_find_contract_by_delta_returns_none_on_fetch_failure(monkeypatch):
    """Network failure → None, no exception escapes."""
    def boom(*a, **kw): raise RuntimeError("network")
    monkeypatch.setattr(ws, "_alpaca_request", boom)
    c = ws.find_contract_by_delta("QQQ", "put", -0.40, 14, 28)
    assert c is None


def test_find_contract_by_delta_returns_none_on_empty_chain(monkeypatch):
    """No snapshots returned → None."""
    class FakeResp:
        def raise_for_status(self): pass
        def json(self): return {"snapshots": {}}
    monkeypatch.setattr(ws, "_alpaca_request", lambda *a, **kw: FakeResp())
    c = ws.find_contract_by_delta("QQQ", "put", -0.40, 14, 28)
    assert c is None


def test_auto_open_uses_delta_selection_when_configured(monkeypatch):
    """When short_put_target_delta is set, the short leg is picked via
    find_contract_by_delta — find_best_contract is NOT called for the
    short. Long leg still uses find_best_contract (width-walk)."""
    cfg = dict(config.get_mode("manual"))
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate (tested separately)
    cfg["short_put_target_delta"] = -0.40
    cfg["wheelability_bypass_symbols"] = ["QQQ"]
    cfg["trend_filter"] = False
    cfg["wheelability_min"] = 80
    # Verify the manual bp_switch_threshold bump is in place (the test would
    # silently fail-bypass without it on a $5000 BP setup like the one below).
    assert cfg["bp_switch_threshold"] >= 10000

    delta_calls = []
    def fake_by_delta(sym, opt_type, target_delta, dmin, dmax):
        delta_calls.append((sym, opt_type, target_delta))
        return _contract("QQQ260618P00715000", 715.0, "2026-06-18")

    strike_calls = []
    def fake_by_strike(sym, opt_type, target_strike, dmin, dmax, exp_date=None):
        strike_calls.append((sym, opt_type, target_strike))
        # Long candidate one strike below
        return _contract(f"QQQ260618P00{int((target_strike)*1000):08d}",
                         target_strike, "2026-06-18")

    monkeypatch.setattr(ws, "find_contract_by_delta", fake_by_delta)
    monkeypatch.setattr(ws, "find_best_contract", fake_by_strike)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "10000",
                                 "options_buying_power": "5000"})
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: ["QQQ"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda sym, bp, **kw: {"score": 5.0, "price": 720.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [700.0] * 20)
    # short_q used by both legs after the picker
    quotes = {
        "QQQ260618P00715000": {"bid": 12.76, "ask": 13.08},  # short, ~$12.92 mid
        "QQQ260618P00706000": {"bid": 9.79,  "ask": 9.91},   # $9 wide long
        "QQQ260618P00705000": {"bid": 9.41,  "ask": 9.73},
        "QQQ260618P00710000": {"bid": 11.05, "ask": 11.06},
    }
    monkeypatch.setattr(ws, "get_option_quote", lambda occ, **_k: quotes.get(occ))

    opened = []
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda s, l, qty, nc, limit_credit=None:
                            opened.append({"short": s, "long": l, "nc": nc})
                            or {"id": "ord-1"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "5000"}, cfg)

    # Delta-target was used for the short leg
    assert len(delta_calls) == 1
    assert delta_calls[0] == ("QQQ", "put", -0.40)
    # Long leg uses strike-based search (width walk)
    assert any(c[0] == "QQQ" and c[1] == "put" for c in strike_calls)


def test_auto_open_legacy_otm_used_when_no_delta_target(monkeypatch):
    """SM/cons/agg/live config (no short_put_target_delta) → falls back to
    the 10%-OTM strike rule via find_best_contract for the short leg."""
    cfg = dict(SM_CFG)  # sm1000 — no short_put_target_delta key
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate
    cfg["wheelability_min"] = 0
    cfg["trend_filter"] = False

    delta_calls = []
    monkeypatch.setattr(ws, "find_contract_by_delta",
                        lambda *a, **kw: delta_calls.append(a) or None)

    strike_calls = []
    def fake_by_strike(sym, opt_type, target_strike, dmin, dmax, exp_date=None):
        strike_calls.append((sym, target_strike))
        return _contract("CHEAP260618P00018000", 18.0, "2026-06-18")
    monkeypatch.setattr(ws, "find_best_contract", fake_by_strike)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "1000",
                                 "options_buying_power": "1000"})
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: ["CHEAP"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda sym, bp, **kw: {"score": 100.0, "price": 20.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [10.0] * 20)
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: {"bid": 0.50, "ask": 0.55})
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda *a, **kw: {"id": "ord-1"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "1000"}, cfg)

    # Delta path NOT taken
    assert delta_calls == []
    # OTM strike-based search WAS used
    assert any(c[0] == "CHEAP" for c in strike_calls)


def test_auto_open_bypass_symbol_with_low_score_still_attempted(monkeypatch):
    """A bypass symbol (QQQ) with low percentile score still reaches the
    construction loop. Other gates must still gate — but the wheelability
    floor is skipped for these symbols."""
    cfg = dict(config.get_mode("manual"))
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate (tested separately)
    cfg["wheelability_bypass_symbols"] = ["QQQ"]
    cfg["short_put_target_delta"] = None  # use strike path for simplicity
    cfg["wheelability_min"] = 80
    cfg["trend_filter"] = False

    reached = []
    def fake_find(sym, opt_type, target_strike, dmin, dmax, exp_date=None):
        reached.append(sym)
        return None  # return None so construction terminates cleanly
    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "find_contract_by_delta",
                        lambda *a, **kw: None)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "10000",
                                 "options_buying_power": "5000"})
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: ["SOFI", "QQQ"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda sym, bp, **kw:
                            {"score": 100.0, "price": 14.0} if sym == "SOFI"
                            else {"score": 5.0, "price": 720.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [10.0] * 20)
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: {"bid": 0.50, "ask": 0.55})
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda *a, **kw: {"id": "ord-1"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "5000"}, cfg)

    # Both symbols reached construction — SOFI on score, QQQ on bypass
    assert "QQQ" in reached, "bypass symbol must reach construction"
    assert "SOFI" in reached, "high-score symbol still reaches construction"


def test_auto_open_non_bypass_low_score_still_blocked(monkeypatch):
    """A non-bypass symbol with a low percentile score is filtered out
    (legacy behavior). This is the regression check: I did not accidentally
    open the gate for everything when adding bypass."""
    cfg = dict(config.get_mode("manual"))
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate (tested separately)
    cfg["wheelability_bypass_symbols"] = ["QQQ"]
    cfg["short_put_target_delta"] = None
    cfg["wheelability_min"] = 80
    cfg["trend_filter"] = False

    reached = []
    def fake_find(sym, opt_type, target_strike, dmin, dmax, exp_date=None):
        reached.append(sym)
        return None
    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "find_contract_by_delta",
                        lambda *a, **kw: None)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "10000",
                                 "options_buying_power": "5000"})
    # JUNK has a low score AND is not in bypass → must be filtered.
    # GOOD has a high score so percentile-rank puts JUNK at 0 (without
    # a comparison symbol the singleton would normalize to 100 and reach
    # construction by score, not bypass — masking the regression check).
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: ["JUNK", "GOOD"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda sym, bp, **kw:
                            {"score": 1.0,   "price": 50.0} if sym == "JUNK"
                            else {"score": 1000.0, "price": 14.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [10.0] * 20)
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: {"bid": 0.50, "ask": 0.55})
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda *a, **kw: {"id": "ord-1"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "5000"}, cfg)

    assert "JUNK" not in reached, "non-bypass low-score symbol must NOT be reached"
    assert "GOOD" in reached, "high-score symbol still reached (sanity)"


# ── Diagonal-spread bug fix (2026-05-22) ──────────────────────────────
# The first real auto-open on manual ended up as a diagonal (short 06/18
# AAL $13.50, long 06/12 AAL $12.50) because find_best_contract for the
# long leg picked the expiration nearest its own (target_exp = today +
# midpoint), not the short s expiration. Two layers of fix:
#   1. find_best_contract gains an optional exp_date that hard-pins the
#      query to a single expiration. The opener now passes the short s
#      expiration when finding the long leg.
#   2. _open_spread_mleg validates same-expiration up front and raises
#      ValueError on mismatch — defense in depth so future callers cant
#      accidentally place a diagonal.


def test_find_best_contract_respects_exp_date(monkeypatch):
    """When exp_date is set, the API query is locked to that expiration —
    the picker cannot wander to a closer-target_exp neighbour."""
    captured = {}
    def fake_api_get(path, params=None):
        captured["path"] = path
        captured["params"] = params
        # Return a single matching contract so the picker has something
        # to choose. Any other date would be filtered out by Alpaca.
        return {"option_contracts": [
            {"symbol": "AAL260618P00012500",
             "strike_price": "12.50",
             "expiration_date": "2026-06-18"},
        ]}
    monkeypatch.setattr(ws, "api_get", fake_api_get)
    c = ws.find_best_contract("AAL", "put", 12.50, 14, 28, exp_date="2026-06-18")
    assert c is not None
    assert c["symbol"] == "AAL260618P00012500"
    # The API params force a single expiration both sides
    assert captured["params"]["expiration_date_gte"] == "2026-06-18"
    assert captured["params"]["expiration_date_lte"] == "2026-06-18"


def test_find_best_contract_no_exp_date_uses_window(monkeypatch):
    """When exp_date is unset (legacy callers), the picker keeps the
    DTE window behaviour — regression check."""
    captured = {}
    monkeypatch.setattr(ws, "api_get",
                        lambda path, params=None: captured.update(params=params)
                        or {"option_contracts": [
                            {"symbol": "AAL260612P00012500",
                             "strike_price": "12.50",
                             "expiration_date": "2026-06-12"}]})
    ws.find_best_contract("AAL", "put", 12.50, 14, 28)
    assert captured["params"]["expiration_date_gte"] != captured["params"]["expiration_date_lte"]


def test_open_spread_mleg_rejects_mismatched_expirations(monkeypatch):
    """Defense-in-depth: even if a future caller forgets to pin expiration,
    the mleg primitive refuses to submit a diagonal."""
    posted = []
    monkeypatch.setattr(ws, "api_post",
                        lambda p, b: posted.append((p, b)) or {"id": "x"})
    import pytest
    with pytest.raises(ValueError) as exc:
        ws._open_spread_mleg(
            short_occ="AAL260618P00013500",  # 06/18
            long_occ="AAL260612P00012500",   # 06/12 — mismatch!
            qty=1,
            net_credit=0.34,
        )
    assert "diagonal" in str(exc.value).lower()
    assert posted == [], "no order should have been submitted"


def test_open_spread_mleg_accepts_matched_expirations(monkeypatch):
    """Verticals (same expiration) still pass through unchanged."""
    posted = []
    monkeypatch.setattr(ws, "api_post",
                        lambda p, b: posted.append((p, b)) or {"id": "x"})
    ws._open_spread_mleg(
        short_occ="AAL260618P00013500",
        long_occ="AAL260618P00012500",  # same expiration
        qty=1, net_credit=0.34,
    )
    assert len(posted) == 1
    assert posted[0][0] == "/orders"
    assert posted[0][1]["order_class"] == "mleg"


def test_auto_open_long_leg_pinned_to_short_expiration(monkeypatch):
    """End-to-end: when the auto-opener picks a short via delta-target,
    the long-leg picker is called with exp_date set to the shorts
    expiration. This is the AAL diagonal regression check."""
    import config
    cfg = dict(config.get_mode("manual"))
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate (tested separately)
    cfg["short_put_target_delta"] = -0.40
    cfg["wheelability_bypass_symbols"] = ["AAL"]
    cfg["trend_filter"] = False
    cfg["wheelability_min"] = 80

    # Short returned at 06/18 expiration
    monkeypatch.setattr(ws, "find_contract_by_delta",
                        lambda *a, **kw: {"symbol": "AAL260618P00013500",
                                          "strike_price": "13.50",
                                          "expiration_date": "2026-06-18"})

    long_call_args = []
    def fake_find_long(sym, opt_type, target_strike, dmin, dmax, exp_date=None):
        long_call_args.append({"target_strike": target_strike,
                               "exp_date": exp_date,
                               "dmin": dmin, "dmax": dmax})
        return None  # terminate construction cleanly
    monkeypatch.setattr(ws, "find_best_contract", fake_find_long)
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "10000",
                                 "options_buying_power": "5000"})
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: ["AAL"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda sym, bp, **kw: {"score": 5.0, "price": 14.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [13.0] * 20)
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: {"bid": 0.56, "ask": 0.60})
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda *a, **kw: {"id": "ord-1"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    ws._auto_open_spread({"_meta": {}},
                         {"options_buying_power": "5000"}, cfg)

    # Every long-leg find call must carry exp_date = short s expiration
    assert len(long_call_args) >= 1
    for call in long_call_args:
        assert call["exp_date"] == "2026-06-18", \
            f"long-leg picker must pin to short s expiration; got {call}"



# ── max_opens_per_cycle: 2 + retry-on-403 (2026-05-22 follow-up) ──────────
#
# After confirming the score-race winner always grabs the single slot and
# QQQ/SPY/IWM (in the bypass tail) never get reached, bumped manual's
# max_opens_per_cycle to 2 and switched the open-failure path from `return`
# to `continue` so a 403 on one symbol doesn't burn the whole cycle.


def test_auto_open_failure_falls_through_to_next_symbol(monkeypatch):
    """When _open_spread_mleg raises (e.g. Alpaca 403 on NVDA/MU), the
    opener does NOT return — it logs the failure and tries the next
    eligible symbol. Previously the cycle would no-op even though other
    candidates were viable."""
    # Two equally-priced symbols both pass the gauntlet. The FIRST one
    # raises, the second one fills. With the legacy `return` we'd see
    # zero opens; with the new `continue` we see one.
    scored = {"BOOM": {"score": 100.0, "price": 20.0},
              "GOOD": {"score": 99.0,  "price": 20.0}}
    contracts = {
        ("BOOM", 18.0): _contract("BOOM260612P00018000", 18.0),
        ("BOOM", 17.0): _contract("BOOM260612P00017000", 17.0),
        ("GOOD", 18.0): _contract("GOOD260612P00018000", 18.0),
        ("GOOD", 17.0): _contract("GOOD260612P00017000", 17.0),
    }
    quotes = {
        "BOOM260612P00018000": {"bid": 0.50, "ask": 0.60},
        "BOOM260612P00017000": {"bid": 0.15, "ask": 0.25},
        "GOOD260612P00018000": {"bid": 0.50, "ask": 0.60},
        "GOOD260612P00017000": {"bid": 0.15, "ask": 0.25},
    }
    cfg, _ = _wire_sm(
        monkeypatch,
        equity=2000, options_bp=2000,
        scored=scored,
        earnings_within={s: False for s in scored},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    # Force both symbols through the wheelability floor — with only 2
    # scored symbols, percentile-rank lands the lower one at 0 and the
    # 80 floor would block GOOD before it's ever reached for fall-through.
    cfg["wheelability_min"] = 0

    opened = []
    def fake_mleg(short_occ, long_occ, qty, net_credit, limit_credit=None):
        if "BOOM" in short_occ:
            raise RuntimeError("HTTP 403 Forbidden")
        opened.append({"short": short_occ, "long": long_occ})
        return {"id": "ord-good"}
    monkeypatch.setattr(ws, "_open_spread_mleg", fake_mleg)

    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)

    assert len(opened) == 1, "failure on BOOM must not block GOOD"
    assert opened[0]["short"] == "GOOD260612P00018000"


def test_auto_open_manual_opens_two_per_cycle(monkeypatch):
    """With manual cfg's max_opens_per_cycle=2, the loop opens up to TWO
    spreads in a single cycle (e.g. one single-stock + one bypass ETF).
    Verifies opens_this_cycle counter respects the cap and stops at 2."""
    cfg = dict(config.get_mode("manual"))
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate (tested separately)
    cfg["wheelability_min"] = 0  # let everything through
    cfg["trend_filter"] = False
    cfg["short_put_target_delta"] = None  # use strike-based path
    cfg["min_credit_to_width_pct"] = None  # disable c/w gate for this test
    cfg["max_risk_pct_equity"] = 0.50  # plenty of headroom

    # 3 symbols available; should open exactly 2 (cap = 2)
    scored = {"AAA": {"score": 100.0, "price": 20.0},
              "BBB": {"score": 99.0,  "price": 20.0},
              "CCC": {"score": 98.0,  "price": 20.0}}
    contracts_by_strike = {
        ("AAA", 18.0): _contract("AAA260612P00018000", 18.0),
        ("AAA", 17.0): _contract("AAA260612P00017000", 17.0),
        ("BBB", 18.0): _contract("BBB260612P00018000", 18.0),
        ("BBB", 17.0): _contract("BBB260612P00017000", 17.0),
        ("CCC", 18.0): _contract("CCC260612P00018000", 18.0),
        ("CCC", 17.0): _contract("CCC260612P00017000", 17.0),
    }

    def fake_score(symbol, free_bp, **kw):
        return scored.get(symbol)
    monkeypatch.setattr(screener_core, "score_candidate", fake_score)
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: sorted(scored.keys()))
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "10000",
                                 "options_buying_power": "10000"})
    def fake_find(u, t, ts, dmin, dmax, exp_date=None):
        cands = {k[1]: v for k, v in contracts_by_strike.items() if k[0] == u}
        if not cands:
            return None
        best = min(cands, key=lambda s: abs(s - ts))
        return cands[best]
    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: {"bid": 0.50, "ask": 0.60} if "18000" in occ
                                    else {"bid": 0.15, "ask": 0.25})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [10.0] * 20)

    opened = []
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda s, l, q, nc, limit_credit=None:
                            opened.append(s) or {"id": "ord"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "10000"}, cfg)

    assert len(opened) == 2, f"manual must open 2/cycle, got {len(opened)}"
    # Highest-scoring two — AAA and BBB
    assert "AAA260612P00018000" in opened
    assert "BBB260612P00018000" in opened


def test_auto_open_sm_modes_still_cap_at_one(monkeypatch):
    """Regression: SM modes left at max_opens_per_cycle=1 must continue
    to stop after one open. Only manual was bumped to 2."""
    scored = {"AAA": {"score": 100.0, "price": 20.0},
              "BBB": {"score": 99.0,  "price": 20.0}}
    contracts = {
        ("AAA", 18.0): _contract("AAA260612P00018000", 18.0),
        ("AAA", 17.0): _contract("AAA260612P00017000", 17.0),
        ("BBB", 18.0): _contract("BBB260612P00018000", 18.0),
        ("BBB", 17.0): _contract("BBB260612P00017000", 17.0),
    }
    quotes = {
        "AAA260612P00018000": {"bid": 0.50, "ask": 0.60},
        "AAA260612P00017000": {"bid": 0.15, "ask": 0.25},
        "BBB260612P00018000": {"bid": 0.50, "ask": 0.60},
        "BBB260612P00017000": {"bid": 0.15, "ask": 0.25},
    }
    cfg, opened = _wire_sm(  # _wire_sm uses sm1000 cfg
        monkeypatch,
        equity=2000, options_bp=2000,
        scored=scored,
        earnings_within={s: False for s in scored},
        contracts_by_strike=contracts,
        quotes=quotes,
    )
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)
    assert len(opened) == 1, "sm modes must still cap at 1"
    assert cfg["max_opens_per_cycle"] == 1, "sm1000 max_opens must be 1"


# ── Bypass priority + inline concurrency cap (2026-05-22 follow-up) ───────
#
# After shipping max_opens_per_cycle=2 + retry-on-failure, observed that
# QQQ STILL never opened because the score-sorted iteration put ETFs at
# the BOTTOM (low premium-yield scores) and the 2 slots were always eaten
# by higher-scoring single stocks first. Also confirmed the concurrency-
# cap edge case: 3 open + 2 new opens this cycle = 5 spreads vs cap 4.
# Two fixes shipped together.


def test_auto_open_bypass_symbols_tried_first(monkeypatch):
    """Bypass symbols MUST be tried before single stocks, regardless of
    score. With max_opens_per_cycle=2, ensures QQQ et al actually get
    attempts every cycle instead of being starved by higher-scoring
    single stocks consuming all slots."""
    cfg = dict(config.get_mode("manual"))
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate (tested separately)
    cfg["short_put_target_delta"] = None  # strike path for easier mocking
    cfg["wheelability_bypass_symbols"] = ["QQQ"]
    cfg["wheelability_min"] = 80
    cfg["trend_filter"] = False
    cfg["min_credit_to_width_pct"] = None
    cfg["max_risk_pct_equity"] = 0.50

    # GOOD scores 100 (top), QQQ scores 5 (bottom, but in bypass set).
    # Without the bypass-first reorder, GOOD would be tried first; with
    # the reorder, QQQ is tried first.
    scored = {"GOOD": {"score": 100.0, "price": 20.0},
              "QQQ":  {"score":   5.0, "price": 720.0}}
    contracts = {
        ("GOOD", 18.0): _contract("GOOD260612P00018000", 18.0),
        ("GOOD", 17.0): _contract("GOOD260612P00017000", 17.0),
        ("QQQ",  648.0): _contract("QQQ260612P00648000",  648.0),
        ("QQQ",  643.0): _contract("QQQ260612P00643000",  643.0),
    }

    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda sym, bp, **kw: scored.get(sym))
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: sorted(scored.keys()))
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "10000",
                                 "options_buying_power": "10000"})
    def fake_find(u, t, ts, dmin, dmax, exp_date=None):
        cands = {k[1]: v for k, v in contracts.items() if k[0] == u}
        if not cands:
            return None
        return cands[min(cands, key=lambda s: abs(s - ts))]
    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: {"bid": 0.50, "ask": 0.60} if "18000" in occ or "648000" in occ
                                    else {"bid": 0.15, "ask": 0.25})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [10.0] * 20)

    open_order = []
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda s, l, q, nc, limit_credit=None:
                            open_order.append(s) or {"id": "ord"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    ws._auto_open_spread({"_meta": {}},
                         {"options_buying_power": "10000"}, cfg)

    # QQQ must be opened FIRST despite its low score
    assert len(open_order) == 2
    assert "QQQ" in open_order[0], \
        f"bypass symbol must be tried first; first open was {open_order[0]}"
    assert "GOOD" in open_order[1], \
        f"non-bypass should fill second slot; second open was {open_order[1]}"


def test_auto_open_inline_concurrency_cap_stops_mid_cycle(monkeypatch):
    """With max_opens_per_cycle=2 and 3 spreads already open against a
    cap of 4, only ONE more spread should open this cycle (filling the
    4th slot), then break — not blow past cap to 5."""
    cfg = dict(config.get_mode("manual"))
    cfg["wheelability_min_pool"] = None  # isolate from the R12 pool gate (tested separately)
    cfg["short_put_target_delta"] = None
    cfg["wheelability_bypass_symbols"] = []  # disable bypass for this test
    cfg["wheelability_min"] = 0
    cfg["trend_filter"] = False
    cfg["min_credit_to_width_pct"] = None
    cfg["max_risk_pct_equity"] = 0.50
    cfg["max_concurrent_spreads"] = 4

    # Three spreads already in state — simulate cycle 4 of a busy week
    state = {
        "_meta": {},
        "EXISTING1": {"stage": "spread_active", "short_leg": {"occ": "x"},
                      "long_leg": {"occ": "y"}, "expiration": "2026-06-12"},
        "EXISTING2": {"stage": "spread_active", "short_leg": {"occ": "x"},
                      "long_leg": {"occ": "y"}, "expiration": "2026-06-12"},
        "EXISTING3": {"stage": "spread_active", "short_leg": {"occ": "x"},
                      "long_leg": {"occ": "y"}, "expiration": "2026-06-12"},
    }

    # Two new high-score candidates — both viable but only 1 slot left
    scored = {"AAA": {"score": 100.0, "price": 20.0},
              "BBB": {"score":  99.0, "price": 20.0}}
    contracts = {
        ("AAA", 18.0): _contract("AAA260612P00018000", 18.0),
        ("AAA", 17.0): _contract("AAA260612P00017000", 17.0),
        ("BBB", 18.0): _contract("BBB260612P00018000", 18.0),
        ("BBB", 17.0): _contract("BBB260612P00017000", 17.0),
    }
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda sym, bp, **kw: scored.get(sym))
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: sorted(scored.keys()))
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "10000",
                                 "options_buying_power": "10000"})
    def fake_find(u, t, ts, dmin, dmax, exp_date=None):
        cands = {k[1]: v for k, v in contracts.items() if k[0] == u}
        if not cands:
            return None
        return cands[min(cands, key=lambda s: abs(s - ts))]
    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: {"bid": 0.50, "ask": 0.60} if "18000" in occ
                                    else {"bid": 0.15, "ask": 0.25})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes",
                        lambda s, n=20: [10.0] * 20)

    open_order = []
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda s, l, q, nc, limit_credit=None:
                            open_order.append(s) or {"id": "ord"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    ws._auto_open_spread(state, {"options_buying_power": "10000"}, cfg)

    # max_opens=2 but cap=4 with 3 already open → only 1 new spread fits
    assert len(open_order) == 1, \
        f"inline cap must stop after 1 open (3 existing + 1 new = 4); got {len(open_order)}"


# ── R12: minimum eligible-pool guard for the percentile wheelability floor ──

def _tiny_pool_wiring(monkeypatch):
    contracts = {
        ("CHEAP", 18.0): _contract("CHEAP260612P00018000", 18.0),
        ("CHEAP", 17.0): _contract("CHEAP260612P00017000", 17.0),
    }
    quotes = {
        "CHEAP260612P00018000": {"bid": 0.55, "ask": 0.65},  # short mid 0.60
        "CHEAP260612P00017000": {"bid": 0.20, "ask": 0.30},  # long mid 0.25
    }
    return _wire_sm(
        monkeypatch, equity=1000, options_bp=2000,
        scored={"CHEAP": {"score": 9.0, "price": 20.0},
                "OTHER": {"score": 3.0, "price": 50.0}},  # 2-name eligible pool
        earnings_within={}, contracts_by_strike=contracts, quotes=quotes,
    )


def test_auto_open_holds_single_stock_on_tiny_pool(monkeypatch):
    """R12: a 2-name pool can't rank, so the percentile floor is meaningless —
    with wheelability_min_pool=5 the single-stock open is held."""
    cfg, opened = _tiny_pool_wiring(monkeypatch)
    cfg["wheelability_min_pool"] = 5
    ws._auto_open_spread({"_meta": {}}, {"options_buying_power": "2000"}, cfg)
    assert opened == []


def test_auto_open_opens_when_pool_meets_minimum(monkeypatch):
    """Control: same 2-name pool, but wheelability_min_pool=2 is satisfied →
    the single-stock open proceeds (the gate only blocks a too-small pool)."""
    cfg, opened = _tiny_pool_wiring(monkeypatch)
    cfg["wheelability_min_pool"] = 2
    ws._auto_open_spread({"_meta": {}}, {"options_buying_power": "2000"}, cfg)
    assert len(opened) == 1


def test_auto_open_pool_gate_off_by_default(monkeypatch):
    """No wheelability_min_pool key (non-SM / unset) → gate inactive, opens as
    before even on a tiny pool."""
    cfg, opened = _tiny_pool_wiring(monkeypatch)
    cfg.pop("wheelability_min_pool", None)
    ws._auto_open_spread({"_meta": {}}, {"options_buying_power": "2000"}, cfg)
    assert len(opened) == 1


def test_auto_open_second_open_respects_consumed_bp(monkeypatch):
    """R14: with max_opens_per_cycle=2 but BP only enough for ONE spread's
    collateral, the second open is blocked because the first open's collateral
    is decremented from the local BP estimate (pre-fix both would open)."""
    cfg = dict(config.get_mode("manual"))
    cfg["wheelability_min_pool"] = None
    cfg["wheelability_min"] = 0
    cfg["trend_filter"] = False
    cfg["short_put_target_delta"] = None
    cfg["min_credit_to_width_pct"] = None
    cfg["max_risk_pct_equity"] = 0.99  # risk gate is not the constraint here

    scored = {"AAA": {"score": 100.0, "price": 20.0},
              "BBB": {"score": 99.0,  "price": 20.0}}
    contracts_by_strike = {
        ("AAA", 18.0): _contract("AAA260612P00018000", 18.0),
        ("AAA", 17.0): _contract("AAA260612P00017000", 17.0),
        ("BBB", 18.0): _contract("BBB260612P00018000", 18.0),
        ("BBB", 17.0): _contract("BBB260612P00017000", 17.0),
    }
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda s, free_bp, **kw: scored.get(s))
    monkeypatch.setattr(screener_core, "build_universe",
                        lambda u, w: sorted(scored.keys()))
    # equity high (risk OK); options_bp only fits one $100-collateral spread
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "10000", "options_buying_power": "150"})

    def fake_find(u, t, ts, dmin, dmax, exp_date=None):
        cands = {k[1]: v for k, v in contracts_by_strike.items() if k[0] == u}
        return cands[min(cands, key=lambda s: abs(s - ts))] if cands else None
    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda occ, **_k: {"bid": 0.50, "ask": 0.60} if "18000" in occ
                                    else {"bid": 0.15, "ask": 0.25})
    monkeypatch.setattr(earnings_mod, "next_earnings_within", lambda s, d: False)
    monkeypatch.setattr(ws, "get_recent_daily_closes", lambda s, n=20: [10.0] * 20)

    opened = []
    monkeypatch.setattr(ws, "_open_spread_mleg",
                        lambda s, l, q, nc, limit_credit=None: opened.append(s) or {"id": "ord"})
    monkeypatch.setattr(ws, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(ws, "log", lambda *a, **kw: None)

    ws.AUTO_OPEN_SPREADS = True
    ws._auto_open_spread({"_meta": {}}, {"options_buying_power": "150"}, cfg)
    assert len(opened) == 1  # second open blocked by the consumed-BP decrement


# ── R15: long-leg quote tolerates a $0 bid (positive ask is enough) ──────────

class _QResp:
    def __init__(self, payload):
        self._p = payload
    def raise_for_status(self):
        pass
    def json(self):
        return self._p


def test_get_option_quote_require_bid_false_accepts_zero_bid(monkeypatch):
    payload = {"quotes": {"X": {"bp": 0, "ap": 0.05}}}
    monkeypatch.setattr(ws, "_alpaca_request", lambda *a, **k: _QResp(payload))
    assert ws.get_option_quote("X", require_bid=False) == {"bid": 0.0, "ask": 0.05}
    assert ws.get_option_quote("X") is None  # default strict still rejects a $0 bid


def test_get_option_quote_rejects_zero_ask_even_when_lenient(monkeypatch):
    payload = {"quotes": {"X": {"bp": 0, "ap": 0}}}
    monkeypatch.setattr(ws, "_alpaca_request", lambda *a, **k: _QResp(payload))
    assert ws.get_option_quote("X", require_bid=False) is None
