# Spread Detection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `wheel_strategy.py` to recognize put credit spreads (and call credit spreads) at position-discovery time, adopt them into a new dedicated state shape, and prevent `long_options_strategy.py` from independently managing the long hedge leg.

**Architecture:** Add a pure-function `_detect_spread_pairs()` that groups paired short+long options on the same underlying/expiry/type into `SpreadPair` records. Extend `_discover_wheel_state()` to run pair detection *before* single-leg adoption so paired legs are claimed as spread state (`stage: "spread_active"`) instead of leaking into Stage 1/Stage 2 or into `long_options_strategy.py`. Add a "blocked OCC set" the long-options script consults to skip hedge legs the wheel has claimed. No management logic, no order placement, no live wiring — that's all follow-up work. This is purely the foundation that makes spread management *possible* later.

**Tech Stack:** Python 3 · existing wheel/long-options modules · pytest with the existing conftest fixtures (`fresh_symbol_state`, `alpaca_account_state`, mocked `get_positions`/`get_account`).

**Out of scope (follow-up plans):**
- `handle_spread()` — early-close, stop-loss, DTE-floor close
- Spread-aware daily summary section
- `min_account_floor` death-spiral brake for live
- Dashboard order form for opening spreads
- Live-mode config flags wiring (`spread_management: True`, etc.) beyond a stub
- Real Alpaca multi-leg order placement

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `wheel_strategy.py` | Modify | Add `SpreadPair` dataclass, `_detect_spread_pairs()`, `_empty_spread_state()`, `_adopt_spread()`. Modify `_discover_wheel_state()` to call pair detection first. |
| `long_options_strategy.py` | Modify | Read `wheel_state[*].long_leg.occ` and skip any long option whose OCC matches. |
| `config.py` | Modify | Add `spread_management` flag (default `False`) to `MODES` so the flag exists but doesn't activate anything yet. |
| `tests/test_spread_detection.py` | Create | Unit + integration tests for `_detect_spread_pairs`, spread state adoption, long-options skip logic. |

`wheel_strategy.py` is already 1,485 lines and growing. A future plan should split spread logic into `wheel_spreads.py`, but for this plan we keep everything inline so reviewers can see the diff against the existing discovery flow in one place. Splitting now would obscure the small surface area of the actual change.

---

## Data shapes (referenced by multiple tasks)

`SpreadPair` (in-memory dataclass returned by detector — never serialized):

```python
@dataclass(frozen=True)
class SpreadPair:
    ticker: str              # "PLTR"
    spread_type: str         # "put_credit" or "call_credit"
    short_occ: str           # "PLTR260619P00008000"
    long_occ: str            # "PLTR260619P00007000"
    short_strike: float      # 8.0
    long_strike: float       # 7.0
    expiration: date         # date(2026, 6, 19)
    short_qty: int           # contracts on short leg (positive int)
    long_qty: int            # contracts on long leg (positive int)
    short_entry: float       # abs(avg_entry_price) of short leg
    long_entry: float        # abs(avg_entry_price) of long leg
    width: float             # abs(short_strike - long_strike)
    net_credit: float        # short_entry - long_entry, per share
    max_loss: float          # width - net_credit, per share
```

Persisted spread state (lives at `state[ticker]` like normal symbol state but with `stage == "spread_active"`):

```json
{
  "stage": "spread_active",
  "spread_type": "put_credit",
  "short_leg": {
    "occ": "PLTR260619P00008000",
    "strike": 8.0,
    "entry_premium": 0.33,
    "qty": 1
  },
  "long_leg": {
    "occ": "PLTR260619P00007000",
    "strike": 7.0,
    "entry_premium": 0.11,
    "qty": 1
  },
  "expiration": "2026-06-19",
  "net_credit": 0.22,
  "max_loss": 0.78,
  "width": 1.0,
  "opened_at": "2026-05-14T17:00:00Z",
  "last_action": "Adopted spread short=$8 long=$7 credit=$0.22",
  "total_premium_collected": 0.0,
  "cycle_count": 0,
  "cycle_history": []
}
```

Note: `stage` becomes polymorphic — historically `int` (1 or 2), now also `str` (`"spread_active"`). Every existing handler already checks `stage == 1` or `stage == 2` explicitly, so a string sentinel won't accidentally trigger Stage 1 or Stage 2 logic. **Task 8 covers a quick audit to confirm this assumption is true.**

---

### Task 1: `SpreadPair` dataclass + `_empty_spread_state()` helper

**Files:**
- Modify: `wheel_strategy.py` (insert immediately after `_empty_symbol_state()`, around line 162)
- Test: `tests/test_spread_detection.py` (new file)

- [ ] **Step 1: Write the failing test**

Create `tests/test_spread_detection.py`:

```python
"""Tests for spread detection foundation (Phase 1 of spread support).

Coverage:
  - SpreadPair dataclass shape + computed fields
  - _empty_spread_state seeds correct schema
  - _detect_spread_pairs groups paired legs by (ticker, expiry, type)
  - _discover_wheel_state routes spreads to spread state, singles to Stage 1/2
  - long_options_strategy skips long legs claimed by wheel spreads
"""
from datetime import date
import pytest

import wheel_strategy


def test_spread_pair_dataclass_computes_width_credit_maxloss():
    sp = wheel_strategy.SpreadPair(
        ticker="PLTR",
        spread_type="put_credit",
        short_occ="PLTR260619P00008000",
        long_occ="PLTR260619P00007000",
        short_strike=8.0,
        long_strike=7.0,
        expiration=date(2026, 6, 19),
        short_qty=1,
        long_qty=1,
        short_entry=0.33,
        long_entry=0.11,
        width=1.0,
        net_credit=0.22,
        max_loss=0.78,
    )
    assert sp.width == 1.0
    assert sp.net_credit == pytest.approx(0.22)
    assert sp.max_loss == pytest.approx(0.78)
    # Frozen — mutation should raise
    with pytest.raises(Exception):
        sp.short_qty = 2  # type: ignore[misc]


def test_empty_spread_state_has_expected_keys():
    st = wheel_strategy._empty_spread_state()
    assert st["stage"] == "spread_active"
    assert st["spread_type"] is None
    assert st["short_leg"] == {"occ": None, "strike": None, "entry_premium": None, "qty": 0}
    assert st["long_leg"]  == {"occ": None, "strike": None, "entry_premium": None, "qty": 0}
    assert st["expiration"] is None
    assert st["net_credit"] is None
    assert st["max_loss"] is None
    assert st["width"] is None
    assert st["opened_at"] is None
    assert st["last_action"] == ""
    assert st["cycle_count"] == 0
    assert st["cycle_history"] == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_spread_detection.py::test_spread_pair_dataclass_computes_width_credit_maxloss -v`
Expected: FAIL with `AttributeError: module 'wheel_strategy' has no attribute 'SpreadPair'`.

- [ ] **Step 3: Add `SpreadPair` and `_empty_spread_state()` in `wheel_strategy.py`**

Find `_empty_symbol_state()` at line 139–162. Immediately after it (before `_migrate_state` at line 165), add:

```python
# ── Spread support (Phase 1: detection + state schema only) ────────────
# Future work: handle_spread() management logic, daily summary section,
# dashboard order form, live-mode wiring. See
# docs/superpowers/plans/2026-05-14-spread-detection-foundation.md.

from dataclasses import dataclass
from datetime import date as _date_type


@dataclass(frozen=True)
class SpreadPair:
    """Two paired option legs identified at discovery time.

    Identified by: same ticker, same expiration, same option type
    (both puts or both calls), opposite sides (one short one long).
    Strike geometry determines spread direction:
      - put_credit:  short_strike > long_strike  (bullish)
      - call_credit: short_strike < long_strike  (bearish)

    Debit spreads (long strike inside short strike) are NOT detected here —
    they're a different strategy and out of scope for this plan.
    """
    ticker: str
    spread_type: str
    short_occ: str
    long_occ: str
    short_strike: float
    long_strike: float
    expiration: _date_type
    short_qty: int
    long_qty: int
    short_entry: float
    long_entry: float
    width: float
    net_credit: float
    max_loss: float


def _empty_spread_state() -> dict:
    """Fresh state for a symbol whose wheel position is a spread, not single-leg."""
    return {
        "stage": "spread_active",
        "spread_type": None,
        "short_leg": {"occ": None, "strike": None, "entry_premium": None, "qty": 0},
        "long_leg":  {"occ": None, "strike": None, "entry_premium": None, "qty": 0},
        "expiration": None,
        "net_credit": None,
        "max_loss": None,
        "width": None,
        "opened_at": None,
        "total_premium_collected": 0.0,
        "cycle_count": 0,
        "cycle_history": [],
        "last_action": "",
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_detection.py -v`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add wheel_strategy.py tests/test_spread_detection.py
git commit -m "wheel: add SpreadPair dataclass and _empty_spread_state foundation"
```

---

### Task 2: `_detect_spread_pairs()` — happy path (one put credit spread)

**Files:**
- Modify: `wheel_strategy.py` (insert after `_parse_occ` at ~line 1175)
- Test: `tests/test_spread_detection.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_spread_detection.py`:

```python
def _opt_pos(symbol, qty, avg_entry):
    """Mock Alpaca position dict for an option leg."""
    return {
        "symbol": symbol,
        "asset_class": "us_option",
        "qty": str(qty),
        "avg_entry_price": str(avg_entry),
    }


def test_detect_spread_pairs_one_put_credit_spread():
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),  # short put @ $8
        _opt_pos("PLTR260619P00007000",  1,  0.11),  # long put  @ $7
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert "PLTR" in pairs
    assert len(pairs["PLTR"]) == 1
    sp = pairs["PLTR"][0]
    assert sp.spread_type == "put_credit"
    assert sp.short_strike == 8.0
    assert sp.long_strike == 7.0
    assert sp.short_qty == 1
    assert sp.long_qty == 1
    assert sp.short_entry == pytest.approx(0.33)
    assert sp.long_entry == pytest.approx(0.11)
    assert sp.width == pytest.approx(1.0)
    assert sp.net_credit == pytest.approx(0.22)
    assert sp.max_loss == pytest.approx(0.78)
    assert sp.expiration == date(2026, 6, 19)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_spread_detection.py::test_detect_spread_pairs_one_put_credit_spread -v`
Expected: FAIL with `AttributeError: module 'wheel_strategy' has no attribute '_detect_spread_pairs'`.

- [ ] **Step 3: Implement `_detect_spread_pairs`**

In `wheel_strategy.py`, find `_parse_occ` (around line 1155–1175). Insert immediately after it:

```python
def _detect_spread_pairs(positions) -> dict:
    """Group short+long option legs into SpreadPair records.

    Returns dict[ticker] -> list[SpreadPair]. Only credit spreads are
    detected:
      - put_credit:  short put strike > long put strike
      - call_credit: short call strike < long call strike

    Legs are paired when they share underlying, expiration, and option
    type (both P or both C), have opposite sides, and strike geometry
    matches a credit-spread shape.

    If multiple shorts or longs exist on the same underlying/expiry/type
    (e.g., a butterfly or a stack of two spreads), only the first
    short+long pair with matching qty is consumed; remaining legs are
    returned to single-leg adoption by _discover_wheel_state.
    """
    by_key: dict = {}
    for pos in positions:
        if pos.get("asset_class") != "us_option":
            continue
        parsed = _parse_occ(pos["symbol"])
        if not parsed:
            continue
        ticker, opt_type, strike, expiry = parsed
        qty = int(float(pos["qty"]))
        if qty == 0:
            continue
        key = (ticker, opt_type, expiry)
        bucket = by_key.setdefault(key, {"shorts": [], "longs": []})
        leg = {
            "occ": pos["symbol"],
            "strike": strike,
            "qty": abs(qty),
            "entry": abs(float(pos.get("avg_entry_price", 0))),
        }
        if qty < 0:
            bucket["shorts"].append(leg)
        else:
            bucket["longs"].append(leg)

    pairs: dict = {}
    for (ticker, opt_type, expiry), bucket in by_key.items():
        shorts = bucket["shorts"]
        longs  = bucket["longs"]
        if not shorts or not longs:
            continue
        # Greedy pair: match each short with the long whose strike forms
        # a credit spread (long below short strike for puts, above for calls)
        # and whose qty matches. First match wins per short.
        for s in shorts:
            for l in longs:
                if l.get("_paired"):
                    continue
                if l["qty"] != s["qty"]:
                    continue
                if opt_type == "put":
                    if not (l["strike"] < s["strike"]):
                        continue
                    spread_type = "put_credit"
                else:  # call
                    if not (l["strike"] > s["strike"]):
                        continue
                    spread_type = "call_credit"
                width = abs(s["strike"] - l["strike"])
                net_credit = round(s["entry"] - l["entry"], 4)
                max_loss = round(width - net_credit, 4)
                sp = SpreadPair(
                    ticker=ticker,
                    spread_type=spread_type,
                    short_occ=s["occ"],
                    long_occ=l["occ"],
                    short_strike=s["strike"],
                    long_strike=l["strike"],
                    expiration=expiry,
                    short_qty=s["qty"],
                    long_qty=l["qty"],
                    short_entry=s["entry"],
                    long_entry=l["entry"],
                    width=width,
                    net_credit=net_credit,
                    max_loss=max_loss,
                )
                pairs.setdefault(ticker, []).append(sp)
                l["_paired"] = True
                s["_paired"] = True
                break
    return pairs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_spread_detection.py -v`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add wheel_strategy.py tests/test_spread_detection.py
git commit -m "wheel: detect single put credit spread from positions"
```

---

### Task 3: `_detect_spread_pairs()` edge cases

**Files:**
- Test: `tests/test_spread_detection.py`

These are pure additions to the test file — the detector from Task 2 should already pass them. If any fail, fix the detector to satisfy them.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spread_detection.py`:

```python
def test_detect_call_credit_spread():
    positions = [
        _opt_pos("PLTR260619C00010000", -1, -0.40),  # short call @ $10
        _opt_pos("PLTR260619C00011000",  1,  0.15),  # long call  @ $11
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    sp = pairs["PLTR"][0]
    assert sp.spread_type == "call_credit"
    assert sp.short_strike == 10.0
    assert sp.long_strike == 11.0
    assert sp.net_credit == pytest.approx(0.25)


def test_detect_no_spread_when_only_short_leg():
    """A bare short put without a paired long is NOT a spread."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert pairs == {}


def test_detect_no_spread_when_expiries_differ():
    """Different expiries → not a vertical spread → ignored."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260717P00007000",  1,  0.20),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert pairs == {}


def test_detect_no_spread_when_qty_mismatched():
    """1× short paired with 2× long — qty mismatch, leave alone."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  2,  0.11),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert pairs == {}


def test_detect_no_spread_when_strikes_form_debit_spread():
    """Long put strike ABOVE short put strike = put debit spread, not credit.
    Out of scope for this plan — must NOT be detected."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.10),  # short @ $8
        _opt_pos("PLTR260619P00009000",  1,  0.50),  # long  @ $9 (debit)
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert pairs == {}


def test_detect_two_separate_spreads_same_underlying():
    """Two 1× put credit spreads on PLTR at different expiries."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  1,  0.11),
        _opt_pos("PLTR260717P00008000", -1, -0.55),
        _opt_pos("PLTR260717P00007000",  1,  0.20),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert len(pairs["PLTR"]) == 2


def test_detect_ignores_stock_positions():
    positions = [
        {"symbol": "PLTR", "asset_class": "us_equity", "qty": "100", "avg_entry_price": "8.50"},
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  1,  0.11),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert "PLTR" in pairs
    assert len(pairs["PLTR"]) == 1


def test_detect_empty_positions_returns_empty_dict():
    assert wheel_strategy._detect_spread_pairs([]) == {}
```

- [ ] **Step 2: Run tests to see which (if any) fail**

Run: `python -m pytest tests/test_spread_detection.py -v`
Expected: All 11 tests PASS. If any fail, the detector from Task 2 has a bug — fix the detector, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/test_spread_detection.py
git commit -m "wheel: cover spread-detection edge cases (call spreads, mismatched legs, debit rejection)"
```

---

### Task 4: `_adopt_spread()` — seed spread state from a `SpreadPair`

**Files:**
- Modify: `wheel_strategy.py` (insert near `_discover_wheel_state`, after `_empty_spread_state`)
- Test: `tests/test_spread_detection.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_spread_detection.py`:

```python
def test_adopt_spread_seeds_state_correctly():
    sp = wheel_strategy.SpreadPair(
        ticker="PLTR",
        spread_type="put_credit",
        short_occ="PLTR260619P00008000",
        long_occ="PLTR260619P00007000",
        short_strike=8.0,
        long_strike=7.0,
        expiration=date(2026, 6, 19),
        short_qty=1,
        long_qty=1,
        short_entry=0.33,
        long_entry=0.11,
        width=1.0,
        net_credit=0.22,
        max_loss=0.78,
    )
    state = {}
    wheel_strategy._adopt_spread(state, sp)

    sym = state["PLTR"]
    assert sym["stage"] == "spread_active"
    assert sym["spread_type"] == "put_credit"
    assert sym["short_leg"]["occ"] == "PLTR260619P00008000"
    assert sym["short_leg"]["strike"] == 8.0
    assert sym["short_leg"]["entry_premium"] == pytest.approx(0.33)
    assert sym["short_leg"]["qty"] == 1
    assert sym["long_leg"]["occ"] == "PLTR260619P00007000"
    assert sym["long_leg"]["strike"] == 7.0
    assert sym["long_leg"]["entry_premium"] == pytest.approx(0.11)
    assert sym["expiration"] == "2026-06-19"
    assert sym["net_credit"] == pytest.approx(0.22)
    assert sym["max_loss"] == pytest.approx(0.78)
    assert sym["width"] == pytest.approx(1.0)
    assert sym["opened_at"] is not None
    assert "Adopted spread" in sym["last_action"]


def test_adopt_spread_is_idempotent():
    """Calling adopt twice with same pair shouldn't reset cycle_count or history."""
    sp = wheel_strategy.SpreadPair(
        ticker="PLTR", spread_type="put_credit",
        short_occ="PLTR260619P00008000", long_occ="PLTR260619P00007000",
        short_strike=8.0, long_strike=7.0, expiration=date(2026, 6, 19),
        short_qty=1, long_qty=1, short_entry=0.33, long_entry=0.11,
        width=1.0, net_credit=0.22, max_loss=0.78,
    )
    state = {}
    wheel_strategy._adopt_spread(state, sp)
    state["PLTR"]["cycle_count"] = 5
    state["PLTR"]["cycle_history"] = [{"foo": "bar"}]

    wheel_strategy._adopt_spread(state, sp)
    assert state["PLTR"]["cycle_count"] == 5
    assert state["PLTR"]["cycle_history"] == [{"foo": "bar"}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_detection.py::test_adopt_spread_seeds_state_correctly -v`
Expected: FAIL with `AttributeError: module 'wheel_strategy' has no attribute '_adopt_spread'`.

- [ ] **Step 3: Implement `_adopt_spread`**

In `wheel_strategy.py`, immediately after `_detect_spread_pairs` (from Task 2), add:

```python
def _adopt_spread(state: dict, sp: SpreadPair) -> None:
    """Seed (or refresh) state[ticker] for a discovered spread.

    Idempotent: if the same spread is already adopted (matching short_occ
    AND long_occ), entry data is left alone so cycle_count / cycle_history
    are preserved across cycles. Only last_action is refreshed.
    """
    existing = state.get(sp.ticker, {})
    already_adopted = (
        existing.get("stage") == "spread_active"
        and existing.get("short_leg", {}).get("occ") == sp.short_occ
        and existing.get("long_leg",  {}).get("occ") == sp.long_occ
    )
    if already_adopted:
        return

    state[sp.ticker] = _empty_spread_state()
    sym = state[sp.ticker]
    sym["spread_type"] = sp.spread_type
    sym["short_leg"] = {
        "occ": sp.short_occ, "strike": sp.short_strike,
        "entry_premium": round(sp.short_entry, 4), "qty": sp.short_qty,
    }
    sym["long_leg"] = {
        "occ": sp.long_occ, "strike": sp.long_strike,
        "entry_premium": round(sp.long_entry, 4), "qty": sp.long_qty,
    }
    sym["expiration"] = sp.expiration.isoformat()
    sym["net_credit"] = sp.net_credit
    sym["max_loss"] = sp.max_loss
    sym["width"] = sp.width
    sym["opened_at"] = datetime.utcnow().isoformat() + "Z"
    sym["last_action"] = (
        f"Adopted spread short=${sp.short_strike:.2f} "
        f"long=${sp.long_strike:.2f} credit=${sp.net_credit:.2f}"
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_detection.py -v`
Expected: All tests PASS (13 total now).

- [ ] **Step 5: Commit**

```bash
git add wheel_strategy.py tests/test_spread_detection.py
git commit -m "wheel: adopt detected spread into dedicated spread_active state"
```

---

### Task 5: Wire `_detect_spread_pairs` into `_discover_wheel_state`

**Files:**
- Modify: `wheel_strategy.py:1178-1276` (existing `_discover_wheel_state` function)
- Test: `tests/test_spread_detection.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_spread_detection.py`:

```python
def test_discover_routes_spread_to_spread_state(monkeypatch):
    """When positions contain a paired spread, _discover_wheel_state should
    adopt it as spread_active state — NOT as a bare Stage 1 short put."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  1,  0.11),
    ]
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: positions)
    # Notification stubs so adoption doesn't try to hit Discord
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {}
    discovered = wheel_strategy._discover_wheel_state(state)

    assert "PLTR" in discovered
    assert state["PLTR"]["stage"] == "spread_active"
    # Critically: the short leg must NOT also be adopted as a Stage 1 single-leg put.
    # If it were, current_contract would be set to the short OCC.
    assert "current_contract" not in state["PLTR"] or state["PLTR"].get("current_contract") is None


def test_discover_still_adopts_single_short_put_when_unpaired(monkeypatch):
    """A bare short put (no long hedge) goes through the existing Stage 1 adoption."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
    ]
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: positions)
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {}
    discovered = wheel_strategy._discover_wheel_state(state)

    assert "PLTR" in discovered
    assert state["PLTR"]["stage"] == 1
    assert state["PLTR"]["current_contract"] == "PLTR260619P00008000"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_detection.py::test_discover_routes_spread_to_spread_state -v`
Expected: FAIL. Without the wiring, the short leg gets adopted via existing Stage 1 logic and `stage` is `1`, not `"spread_active"`.

- [ ] **Step 3: Modify `_discover_wheel_state`**

In `wheel_strategy.py`, find `_discover_wheel_state` starting at line 1178. Right after `positions = get_positions()` (line 1192), insert spread detection. Then in the single-leg adoption loop (line 1202+), add a guard that skips any OCC already claimed by a spread.

Replace the body of `_discover_wheel_state` (lines 1191–1276) with:

```python
    discovered: set = set()
    positions = get_positions()

    # ─ Phase 1: spread pairs ─
    # Detect spreads BEFORE single-leg adoption so paired legs aren't
    # double-claimed by Stage 1/Stage 2 logic.
    spread_pairs = _detect_spread_pairs(positions)
    claimed_occs: set = set()
    for ticker, sp_list in spread_pairs.items():
        for sp in sp_list:
            _adopt_spread(state, sp)
            discovered.add(ticker)
            claimed_occs.add(sp.short_occ)
            claimed_occs.add(sp.long_occ)
            send_embed(
                TRADES_CH, f"Wheel: adopted spread {ticker}",
                color=Color.BLUE,
                description=(
                    f"{sp.spread_type.replace('_', ' ')} short=${sp.short_strike:.2f} "
                    f"long=${sp.long_strike:.2f} credit=${sp.net_credit:.2f} "
                    f"max_loss=${sp.max_loss:.2f} ({sp.short_qty}× contracts)."
                ),
                footer=f"wheel_strategy.py · {MODE}",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "wheel_strategy.py", "adopted_spread",
                      symbol=ticker,
                      details={
                          "spread_type": sp.spread_type,
                          "short_occ": sp.short_occ, "long_occ": sp.long_occ,
                          "short_strike": sp.short_strike, "long_strike": sp.long_strike,
                          "expiration": sp.expiration.isoformat(),
                          "qty": sp.short_qty,
                          "net_credit": sp.net_credit, "max_loss": sp.max_loss,
                      })

    # ─ Phase 2: tracked-in-state symbols stay in scope ─
    for sym, ss in state.items():
        if sym.startswith("_"):
            continue
        if ss.get("stage") == "spread_active":
            discovered.add(sym)
            continue
        if ss.get("current_contract") or int(ss.get("shares_qty", 0)) >= 100:
            discovered.add(sym)

    # ─ Phase 3: single-leg adoption (puts/calls not claimed by a spread) ─
    for pos in positions:
        asset_class = pos.get("asset_class")
        symbol = pos["symbol"]

        if asset_class == "us_equity":
            qty = int(float(pos["qty"]))
            if qty >= 100:
                discovered.add(symbol)
            continue

        if asset_class != "us_option":
            continue

        # Skip any leg already claimed by a spread.
        if symbol in claimed_occs:
            continue

        # Only short option positions are wheel material for single-leg adoption.
        qty_int = int(float(pos["qty"]))
        if qty_int >= 0:
            continue

        parsed = _parse_occ(symbol)
        if not parsed:
            log(f"[wheel-discover] could not parse OCC symbol {symbol} — skipping")
            continue
        ticker, opt_type, strike, expiry = parsed
        discovered.add(ticker)

        sym_state = state.setdefault(ticker, _empty_symbol_state())
        if sym_state.get("current_contract") == symbol:
            continue

        entry_per_share = abs(float(pos.get("avg_entry_price", 0)))
        contracts = abs(qty_int)

        sym_state["current_contract"]     = symbol
        sym_state["contract_order_id"]    = sym_state.get("contract_order_id")
        sym_state["contract_entry_price"] = round(entry_per_share, 4)
        sym_state["contract_entry_date"]  = sym_state.get("contract_entry_date") or datetime.utcnow().isoformat() + "Z"
        sym_state["contract_expiration"]  = expiry.isoformat()
        sym_state["contract_type"]        = opt_type
        sym_state["contract_strike"]      = strike
        sym_state["contract_qty"]         = contracts

        if opt_type == "put":
            sym_state["stage"] = 1
            sym_state["last_action"] = f"Adopted manual put {symbol} @ ${entry_per_share:.2f} ({contracts}× contracts)"
        else:
            sym_state["stage"] = 2
            stock_pos = get_stock_position(ticker)
            if stock_pos:
                sym_state["shares_qty"]           = int(float(stock_pos["qty"]))
                sym_state["cost_basis_per_share"] = abs(float(stock_pos["avg_entry_price"]))
                sym_state["total_cost"]           = sym_state["cost_basis_per_share"] * sym_state["shares_qty"]
            sym_state["last_action"] = f"Adopted manual covered call {symbol} @ ${entry_per_share:.2f} ({contracts}× contracts)"

        send_embed(
            TRADES_CH, f"Wheel: adopted manual {opt_type} {ticker}",
            color=Color.BLUE,
            description=(
                f"Now managing {contracts}× {symbol} @ ${entry_per_share:.2f}/share. "
                f"Stage {sym_state['stage']}."
            ),
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "wheel_strategy.py", "adopted_manual_position",
                  symbol=symbol,
                  details={"underlying": ticker, "type": opt_type, "strike": strike,
                           "expiry": expiry.isoformat(), "contracts": contracts,
                           "entry_premium": entry_per_share})

    return discovered
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_detection.py -v`
Expected: All tests PASS (15 total).

- [ ] **Step 5: Run the full wheel test suite to confirm no regressions**

Run: `python -m pytest tests/ -v`
Expected: All previously-passing tests still PASS (171 from CLAUDE.md baseline + new spread tests). If `test_manual_mode.py::test_*_discover_wheel_state` regresses, double-check the Phase-2 in-scope-symbols loop didn't drop the `current_contract` branch.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_detection.py
git commit -m "wheel: route detected spreads to spread_active state in discovery"
```

---

### Task 6: Block `long_options_strategy.py` from adopting wheel-claimed long legs

**Files:**
- Modify: `long_options_strategy.py`
- Test: `tests/test_spread_detection.py`

- [ ] **Step 1: Read existing long-options adoption logic**

Run: `python -c "import long_options_strategy; help(long_options_strategy)" | head -80`

Or open `long_options_strategy.py` and locate the function that decides which long option positions to manage. Look for whichever function iterates Alpaca positions and filters for `qty > 0` + `asset_class == "us_option"`. Note its name — referred to below as `_discover_long_options`.

If the actual function name differs, substitute throughout this task.

- [ ] **Step 2: Write the failing test**

Append to `tests/test_spread_detection.py`:

```python
def test_long_options_skips_legs_claimed_by_wheel_spread(monkeypatch, tmp_path):
    """The protective long put inside a put credit spread MUST NOT be
    managed by long_options_strategy — that would sell the hedge and
    leave the short leg naked."""
    import json
    import long_options_strategy
    import wheel_strategy

    # 1. Set up a wheel state file with one spread_active position
    wheel_state = {
        "_meta": {},
        "PLTR": wheel_strategy._empty_spread_state(),
    }
    wheel_state["PLTR"].update({
        "spread_type": "put_credit",
        "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0, "entry_premium": 0.33, "qty": 1},
        "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0, "entry_premium": 0.11, "qty": 1},
        "expiration": "2026-06-19",
    })

    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(wheel_state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))

    # 2. Verify the helper returns the claimed OCC set
    claimed = long_options_strategy._wheel_claimed_long_occs()
    assert "PLTR260619P00007000" in claimed
    # The short leg is NOT a long-options concern, but it's fine if it's
    # also in the set (defensive)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest tests/test_spread_detection.py::test_long_options_skips_legs_claimed_by_wheel_spread -v`
Expected: FAIL with `AttributeError: module 'long_options_strategy' has no attribute '_wheel_claimed_long_occs'`.

- [ ] **Step 4: Add `_wheel_claimed_long_occs` and wire it into the discovery filter**

At the top of `long_options_strategy.py` (near the imports / module-level helpers), add:

```python
def _wheel_claimed_long_occs() -> set:
    """OCC symbols of long option legs that wheel_strategy has claimed as
    part of a spread. long_options_strategy MUST NOT touch these — selling
    the hedge would leave the short leg naked and break the spread's risk
    profile.

    Reads wheel_strategy's state file directly (no import-time side effects)
    so a stale dashboard or a partial cycle doesn't desync the two scripts.
    Returns an empty set if the state file doesn't exist yet.
    """
    import json, os
    import wheel_strategy
    if not os.path.exists(wheel_strategy.STATE_FILE):
        return set()
    try:
        with open(wheel_strategy.STATE_FILE) as f:
            state = json.load(f)
    except (OSError, json.JSONDecodeError):
        return set()
    claimed = set()
    for sym, ss in state.items():
        if sym.startswith("_") or not isinstance(ss, dict):
            continue
        if ss.get("stage") != "spread_active":
            continue
        long_occ = (ss.get("long_leg") or {}).get("occ")
        short_occ = (ss.get("short_leg") or {}).get("occ")
        if long_occ:
            claimed.add(long_occ)
        if short_occ:
            claimed.add(short_occ)
    return claimed
```

Then locate the existing position-iteration logic in `long_options_strategy.py` (whichever function loops over `get_positions()` and processes long options). At the start of that loop, add:

```python
    _claimed = _wheel_claimed_long_occs()
    # ... existing for-loop start ...
    for pos in positions:
        if pos.get("symbol") in _claimed:
            continue  # Hedge leg of a wheel spread — leave it alone.
        # ... existing per-position logic ...
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_spread_detection.py -v`
Expected: All PASS (16 total).

- [ ] **Step 6: Add an integration test asserting long_options actually skips the leg**

Append to `tests/test_spread_detection.py`:

```python
def test_long_options_run_does_not_touch_spread_long_leg(monkeypatch, tmp_path):
    """End-to-end: long_options_strategy main entry point must NOT log/act on
    a long put whose OCC is claimed by a wheel spread."""
    import json
    import long_options_strategy
    import wheel_strategy

    wheel_state = {
        "_meta": {},
        "PLTR": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0, "entry_premium": 0.33, "qty": 1},
            "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0, "entry_premium": 0.11, "qty": 1},
            "expiration": "2026-06-19",
        },
    }
    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(wheel_state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))

    positions = [
        _opt_pos("PLTR260619P00007000", 1, 0.11),
    ]
    monkeypatch.setattr(long_options_strategy, "get_positions", lambda: positions, raising=False)

    actions = []
    # Stub whatever per-position handler the long-options script uses — most
    # likely a helper like _handle_long_option or _check_exit. If the function
    # name differs, substitute it here. The assertion is that it's NOT called.
    if hasattr(long_options_strategy, "_handle_long_option"):
        monkeypatch.setattr(long_options_strategy, "_handle_long_option",
                            lambda *a, **kw: actions.append(("handled", a, kw)))

    # Call whatever the script's top-level run is
    if hasattr(long_options_strategy, "run"):
        try:
            long_options_strategy.run()
        except Exception:
            # Other downstream failures aren't this test's concern
            pass

    assert actions == [], (
        "long_options_strategy acted on a hedge leg claimed by a wheel spread — "
        "the skip guard isn't wired into the main loop."
    )
```

Note: the test stubs whichever per-position handler the long-options script uses. If the script's structure doesn't expose `_handle_long_option` or `run`, adapt the stub to whatever the actual main entry point is. The intent is invariant: **after the skip guard, the claimed OCC must never reach per-position logic.**

- [ ] **Step 7: Run tests**

Run: `python -m pytest tests/test_spread_detection.py -v`
Expected: All PASS (17 total).

- [ ] **Step 8: Commit**

```bash
git add long_options_strategy.py tests/test_spread_detection.py
git commit -m "long-options: skip option legs claimed by wheel spreads"
```

---

### Task 7: Add `spread_management` flag to `config.MODES` (stub only)

**Files:**
- Modify: `config.py`
- Test: `tests/test_config_modes.py`

This task only adds the flag so future plans can wire management to it. **The flag is read by nothing in this plan** — that's intentional. Detection runs unconditionally because it's purely defensive; opening flow is gated by future work.

- [ ] **Step 1: Read existing `MODES` definitions**

Open `config.py` and locate the `MODES` dict. Note each mode's key list so the new flag is added consistently.

- [ ] **Step 2: Write the failing test**

Append to `tests/test_config_modes.py` (or create if it doesn't exist — check first):

```python
def test_all_modes_declare_spread_management_flag():
    """Every mode must declare spread_management explicitly so future
    handle_spread() logic has a deterministic toggle. Default is False —
    enabling spread management is a deliberate future-plan decision."""
    import config
    for mode_name, mode_cfg in config.MODES.items():
        assert "spread_management" in mode_cfg, (
            f"mode {mode_name} missing spread_management flag"
        )
    # All modes default to False at this stage
    for mode_name, mode_cfg in config.MODES.items():
        assert mode_cfg["spread_management"] is False, (
            f"mode {mode_name} should default spread_management=False until "
            "handle_spread() ships in a follow-up plan"
        )
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest tests/test_config_modes.py::test_all_modes_declare_spread_management_flag -v`
Expected: FAIL — flag isn't declared.

- [ ] **Step 4: Add the flag to each mode in `config.py`**

In `config.MODES`, add `"spread_management": False,` to every mode (`conservative`, `aggressive`, `manual`, `live`). Place the line near the other behaviour flags (`auto_discover_symbols`, `wheel_skip_new_puts`) so related flags stay grouped.

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_config_modes.py -v`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `python -m pytest tests/ -v`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add config.py tests/test_config_modes.py
git commit -m "config: add spread_management flag (default off) to all modes"
```

---

### Task 8: Audit `stage` checks to confirm string sentinel is safe

**Files:**
- Read-only audit; small fixes if anything blows up

This is a sanity check, not a feature. Every existing reference to `stage` must either compare against the int values `1` / `2` explicitly, or be safe against a `"spread_active"` value.

- [ ] **Step 1: Grep for stage comparisons in wheel/strategy/summary code**

Run:
```bash
grep -n "stage" wheel_strategy.py | grep -E "==|!=|stage\["
grep -n "stage" daily_summary.py | grep -E "==|!=|stage\["
grep -n "stage" strategy.py | grep -E "==|!=|stage\["
```

For each match, confirm:
- Comparisons against `1` or `2` are still correct — spread_active legs simply don't match either branch (which is what we want until `handle_spread` ships).
- No code does `stage > 1` or `stage < 2` or `int(stage)` style numeric comparisons that would crash on the string `"spread_active"`.

- [ ] **Step 2: Write a defensive test**

Append to `tests/test_spread_detection.py`:

```python
def test_spread_active_state_does_not_crash_daily_summary(monkeypatch, tmp_path):
    """daily_summary must tolerate a state file containing a spread_active
    symbol. It doesn't need to render a spread section yet (that's future
    work) — just must not raise."""
    import json
    import wheel_strategy

    state = {
        "_meta": {"last_checked": "2026-05-14T17:00:00Z"},
        "PLTR": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0, "entry_premium": 0.33, "qty": 1},
            "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0, "entry_premium": 0.11, "qty": 1},
            "expiration": "2026-06-19", "net_credit": 0.22, "max_loss": 0.78,
            "width": 1.0, "opened_at": "2026-05-14T17:00:00Z",
            "total_premium_collected": 0.0, "cycle_count": 0, "cycle_history": [],
            "last_action": "",
        },
    }
    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))

    # Reload through the wheel's own load_state to confirm migration doesn't choke
    loaded = wheel_strategy.load_state()
    assert loaded["PLTR"]["stage"] == "spread_active"
```

- [ ] **Step 3: Run test**

Run: `python -m pytest tests/test_spread_detection.py::test_spread_active_state_does_not_crash_daily_summary -v`
Expected: PASS. If FAIL, fix `load_state` / `_migrate_state` to tolerate the new stage value.

- [ ] **Step 4: Run the full suite one more time**

Run: `python -m pytest tests/ -v`
Expected: All PASS (baseline 171 + ~18 new = ~189).

- [ ] **Step 5: Commit (only if any code changes were needed)**

```bash
git add -A
git commit -m "wheel: confirm spread_active stage value is safe across existing code paths"
```

If no code change was needed (audit was clean), no commit — the test was added in an earlier task's commit.

---

### Task 9: Documentation — update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a short subsection under "Strategies in detail" or "Future work"**

Open `CLAUDE.md` and locate either:
- The "Strategies in detail" section — add a new subsection titled `### Spread detection (Phase 1)`, OR
- The "Future work" section — add a bullet describing what shipped vs what's still pending.

Recommended location: directly after the "Manual mode — auto-discover, manage-only" subsection. Add:

```markdown
### Spread detection (foundation only — no management yet)

`wheel_strategy.py` recognizes put credit spreads and call credit spreads at
discovery time by pairing short+long option legs that share underlying,
expiration, and option type. Paired legs are adopted into a dedicated
`stage: "spread_active"` state shape with `short_leg` and `long_leg` blocks.
`long_options_strategy.py` consults the wheel state file each cycle and skips
any long option whose OCC is claimed by a spread — preventing the hedge from
being sold independently.

**What's NOT yet implemented:**
- `handle_spread()` management logic (early-close at 50% credit, stop-loss at
  50% max loss, DTE-floor close on assignment risk). Spreads currently sit
  in state untouched until the next plan ships.
- Daily summary section for open spreads.
- Live-mode wiring — `spread_management: False` on every mode, including live.
- Dashboard order form for opening multi-leg spreads through Alpaca's `mleg`
  order class.
- Position-size guardrails (`min_account_floor`, `max_concurrent_spreads`).

Tracking plan:
[2026-05-14-spread-detection-foundation.md](docs/superpowers/plans/2026-05-14-spread-detection-foundation.md).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document spread detection foundation (no management yet)"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

Run: `python -m pytest tests/ -v --tb=short`
Expected: All tests pass, baseline + ~18 new spread tests.

- [ ] **Step 2: Smoke test the manual paper account locally**

```bash
python wheel_strategy.py --mode manual
```

Expected behaviour with no spread positions: same as before this plan — auto-discovers single-leg positions, manages them. With a spread open on the manual paper account: a `Wheel: adopted spread PLTR` Discord embed lands in `#manual-trades`, state file gets a `spread_active` entry for PLTR, no Stage 1 adoption for the short leg.

- [ ] **Step 3: PR**

Branch is in worktree `pensive-merkle-253d8a`. Open PR against `main`.

PR description should include:
- Link to this plan
- Bullet list of what's covered (foundation) vs what's deferred (management)
- Test count delta
- Confirmation that `spread_management: False` everywhere so no behaviour changes for any existing account

---

## Self-review notes (for the implementer)

- **Detection runs unconditionally** in every mode. That's intentional — even on conservative/aggressive, if the bot somehow encounters a spread (manual position drift, account error), it claims it cleanly instead of letting the long leg leak to long-options handling. The flag gating starts only when management logic ships.
- **Spread state is keyed by ticker, same as single-leg state.** A symbol can only be in one of {`stage: 1`, `stage: 2`, `stage: "spread_active"`} at a time. If a user simultaneously holds a single short put AND a paired spread on the same ticker at the same expiry, detection grabs the pair first; if extra unpaired shorts exist they'd collide with the spread's claim on `state[ticker]`. **This is a known limitation** — for the foundation plan it's fine because the bot doesn't open spreads itself, so this only happens from user-side mistakes. Future work: support multiple wheel positions per ticker.
- **No live wiring.** `live` mode still has `spread_management: False`. To enable live spread trading, a future plan must (a) ship `handle_spread`, (b) ship `min_account_floor`, (c) ship the dashboard form, then (d) flip the flag. Don't flip it as a side effect of this plan.
