# Spread Management (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `handle_spread()` management logic to the wheel — close at 50% profit, stop out at 50% max-loss, force-close near expiration if short leg is ITM, and recover gracefully when one leg disappears unexpectedly. Enabled only on `manual` mode.

**Architecture:** All additions live in `wheel_strategy.py` (extending Phase 1's detection foundation). New functions follow the existing `handle_stage1` / `handle_stage2` pattern. `run_wheel()` gets a `stage == "spread_active"` routing branch. Close mechanic tries Alpaca's multi-leg (`mleg`) order class first, falls back to two individual orders if that fails. Spread state is deleted on successful close (not preserved like single-leg state). A small detector improvement folds in: when multiple `(ticker, opt_type, expiry)` legs could pair, pick the narrowest-width pair first so a bare CSP + spread on the same expiry classifies correctly.

**Tech Stack:** Python 3 · existing wheel/long-options modules · pytest with the existing `conftest.py` fixtures (`fresh_symbol_state`, `alpaca_account_state`, mocked `get_positions`/`get_account`/`api_post`).

**Spec:** [2026-05-14-spread-management-design.md](docs/superpowers/specs/2026-05-14-spread-management-design.md)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `wheel_strategy.py` | Modify | Detector narrowest-width fix (Task 1). `_compute_spread_pnl`, `place_sell_to_close`, `_close_spread_mleg`, `_close_spread_legs_individually`, `_close_spread`, `_handle_orphan_leg`, `handle_spread`. `SPREAD_MANAGEMENT` global + `apply_mode` read. `run_wheel` routing branch. |
| `config.py` | Modify | Add three new keys to every mode: `spread_early_close_pct`, `spread_stop_loss_pct`, `spread_dte_floor`. Flip `spread_management` to `True` on `manual` only. |
| `tests/test_spread_detection.py` | Modify | Add 2 tests for narrowest-width disambiguation. |
| `tests/test_spread_management.py` | Create | ~20 tests covering `_compute_spread_pnl`, `handle_spread` decision tree, close mechanics, orphan handling, `run_wheel` routing. |
| `CLAUDE.md` | Modify | Update Spread Detection section to reflect Phase 2 ship. |

`wheel_strategy.py` will grow from ~1640 lines (post-Phase-1) to ~1940 lines. Still large but follows the established pattern of all wheel logic in one file. A future cleanup plan can split into `wheel_spreads.py`; not in scope here.

---

## Reference: existing helpers we'll reuse

These already exist in `wheel_strategy.py` and are used by tasks below. Listed for the implementer's awareness:

- `api_post(path, body)` — generic Alpaca POST, returns parsed JSON.
- `get_option_quote(contract_symbol)` — returns `{"bid": float, "ask": float}` or `None`.
- `place_buy_to_close(option_symbol, limit_price, qty=None)` — buy-to-close a short option. Already auto-detects qty from Alpaca position if `qty=None`.
- `get_positions()` — list Alpaca positions.
- `get_option_position(contract_symbol)` — single option position dict or `None`.
- `get_latest_price(symbol)` — stock midpoint quote (used for ITM check on the underlying).
- `_parse_occ(occ)` — already used in Phase 1 detection.
- `send_embed(channel, title, color, description, footer, actions_channel)` — Discord embed.
- `log_event(stream, source, event, symbol=..., details={...})` — JSONL logging.
- `log(msg)` — stdout heartbeat logging.
- Module globals from `apply_mode`: `TRADES_CH`, `ACTIONS_CH`, `ERRORS_CH`, `LOG_STREAM`, `MODE`, `Color`.

---

### Task 1: Detector narrowest-width pairing fix

**Files:**
- Modify: `wheel_strategy.py` — `_detect_spread_pairs()` (lines ~1220–1300 post-Phase-1)
- Test: `tests/test_spread_detection.py` (existing file)

**Background:** Phase 1's pairing loop is first-match-wins. If a bucket has 2 shorts + 1 long, it can pick the wrong pair. Example PLTR June 19: short $9 (bare CSP) + short $8 + long $7 (real spread legs). First-match pairs $9 with $7 (a phantom $2-wide "spread"), leaves $8 as a single-leg adoption. Both wrong.

**Fix:** within each bucket, enumerate all valid candidate `(short, long)` pairs, sort by strike-width ascending, then greedy-claim narrowest first.

- [ ] **Step 1: Write the first failing test**

Append to `tests/test_spread_detection.py`:

```python
def test_detect_picks_narrowest_spread_when_csp_and_spread_share_expiry():
    """Bare CSP at $9 short + real spread at $8 short / $7 long, all
    same expiry. Detector must pair $8/$7 (width $1, the real spread)
    and leave $9 short to fall through to single-leg adoption."""
    positions = [
        _opt_pos("PLTR260619P00009000", -1, -0.50),  # bare CSP, deeper-OTM short
        _opt_pos("PLTR260619P00008000", -1, -0.33),  # real spread short
        _opt_pos("PLTR260619P00007000",  1,  0.11),  # real spread long
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert "PLTR" in pairs
    assert len(pairs["PLTR"]) == 1
    sp = pairs["PLTR"][0]
    assert sp.short_strike == 8.0
    assert sp.long_strike == 7.0
    assert sp.width == pytest.approx(1.0)
    # The $9 short must NOT be claimed by a spread — it should remain
    # available for single-leg adoption (we verify that path below).


def test_detect_picks_narrowest_with_call_credit_overlap():
    """Mirror case for call credit spreads: short call $10 (real spread)
    + short call $12 (bare CC) + long call $11 — narrowest pair is $10/$11
    (width $1), leaving $12 short alone."""
    positions = [
        _opt_pos("PLTR260619C00010000", -1, -0.40),  # real spread short
        _opt_pos("PLTR260619C00012000", -1, -0.20),  # bare short call
        _opt_pos("PLTR260619C00011000",  1,  0.15),  # real spread long
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert len(pairs["PLTR"]) == 1
    sp = pairs["PLTR"][0]
    assert sp.short_strike == 10.0
    assert sp.long_strike == 11.0
    assert sp.spread_type == "call_credit"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_detection.py::test_detect_picks_narrowest_spread_when_csp_and_spread_share_expiry tests/test_spread_detection.py::test_detect_picks_narrowest_with_call_credit_overlap -v`

Expected: FAIL. The current first-match-wins logic claims $9 short with $7 long, not $8 with $7.

- [ ] **Step 3: Rewrite the pairing block inside `_detect_spread_pairs`**

In `wheel_strategy.py`, find the second loop body inside `_detect_spread_pairs` — the section labeled `# Greedy pair: match each short with the long whose strike forms` (around line 1283 in the current file). Replace the entire loop body for `for s in shorts:` with a candidate-enumeration approach.

Locate this block:

```python
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

Replace with:

```python
    pairs: dict = {}
    for (ticker, opt_type, expiry), bucket in by_key.items():
        shorts = bucket["shorts"]
        longs  = bucket["longs"]
        if not shorts or not longs:
            continue

        # Enumerate every valid (short, long) candidate pair, then claim
        # narrowest-width first. This handles the case where the user
        # holds a bare CSP and a real spread at the same expiry: the
        # narrower pair is the real spread, and the wider "phantom" pair
        # is rejected so the leftover short falls to single-leg adoption.
        candidates = []
        for s in shorts:
            for l in longs:
                if l["qty"] != s["qty"]:
                    continue
                if opt_type == "put":
                    if not (l["strike"] < s["strike"]):
                        continue
                else:  # call
                    if not (l["strike"] > s["strike"]):
                        continue
                width = abs(s["strike"] - l["strike"])
                candidates.append((width, s, l))

        # Sort by width ascending so narrowest-pair wins
        candidates.sort(key=lambda c: c[0])

        for width, s, l in candidates:
            if s.get("_paired") or l.get("_paired"):
                continue
            spread_type = "put_credit" if opt_type == "put" else "call_credit"
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
            s["_paired"] = True
            l["_paired"] = True
    return pairs
```

- [ ] **Step 4: Run all spread-detection tests**

Run: `python -m pytest tests/test_spread_detection.py -v`

Expected: All Phase 1 tests still pass (12 existing) + 2 new tests pass = 14 total. If any of the older edge-case tests regress, the candidate-enumeration logic has a bug — fix it (don't loosen the tests).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 276 → 278 tests passing.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_detection.py
git commit -m "wheel: narrowest-width pair wins, fixes CSP+spread same-expiry overlap"
```

---

### Task 2: Add spread thresholds to config.MODES

**Files:**
- Modify: `config.py` — `MODES` dict (every mode)
- Test: `tests/test_config_modes.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_config_modes.py`:

```python
def test_all_modes_declare_spread_thresholds():
    """Every mode must declare the three spread management thresholds
    consistently. Default values are: 50% early close, 50% stop loss,
    DTE floor of 2."""
    import config
    expected = {
        "spread_early_close_pct": 0.50,
        "spread_stop_loss_pct":   0.50,
        "spread_dte_floor":       2,
    }
    for mode_name, mode_cfg in config.MODES.items():
        for key, value in expected.items():
            assert key in mode_cfg, f"mode {mode_name} missing {key}"
            assert mode_cfg[key] == value, (
                f"mode {mode_name} {key}={mode_cfg[key]!r}, "
                f"expected {value!r}"
            )


def test_only_manual_has_spread_management_enabled():
    """Phase 2 enables spread management on manual paper account only.
    Other modes must keep spread_management=False until later plans
    flip them deliberately."""
    import config
    assert config.MODES["manual"]["spread_management"] is True
    for mode_name in ("conservative", "aggressive", "live"):
        assert config.MODES[mode_name]["spread_management"] is False, (
            f"mode {mode_name} should still have spread_management=False"
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_config_modes.py::test_all_modes_declare_spread_thresholds tests/test_config_modes.py::test_only_manual_has_spread_management_enabled -v`

Expected: FAIL — keys not declared, manual's `spread_management` is still `False` from Phase 1.

- [ ] **Step 3: Add the three threshold keys to every mode**

In `config.py`, in each of the four mode dicts (`conservative`, `aggressive`, `manual`, `live`) inside `MODES`, find the line `"spread_management":   False,` (added in Phase 1 Task 7). Immediately after it, add three more keys, aligned consistently:

```python
        "spread_management":      False,
        "spread_early_close_pct": 0.50,
        "spread_stop_loss_pct":   0.50,
        "spread_dte_floor":       2,
```

For the `manual` mode specifically, flip `spread_management` to `True`:

```python
        "spread_management":      True,
        "spread_early_close_pct": 0.50,
        "spread_stop_loss_pct":   0.50,
        "spread_dte_floor":       2,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_config_modes.py -v`

Expected: All pass (existing + 2 new).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 278 → 280 tests passing.

- [ ] **Step 6: Commit**

```bash
git add config.py tests/test_config_modes.py
git commit -m "config: add spread thresholds, enable spread_management on manual"
```

---

### Task 3: `_compute_spread_pnl` pure helper + new test file

**Files:**
- Modify: `wheel_strategy.py` — insert immediately after `_empty_spread_state()` and the new `SpreadPair` dataclass (around line 220)
- Create: `tests/test_spread_management.py` (new test file for all Phase 2 tests)

- [ ] **Step 1: Create the new test file with the first failing test**

Create `tests/test_spread_management.py`:

```python
"""Tests for spread management (Phase 2 of spread support).

Coverage:
  - _compute_spread_pnl pure math
  - handle_spread decision tree (profit, stop loss, DTE close, hold)
  - close mechanic (mleg success, fallback to singles, half-closed)
  - orphan-leg handling (short missing, long missing, both missing)
  - run_wheel routing to handle_spread when stage == "spread_active"
"""
from datetime import date
import pytest

import wheel_strategy


def _spread_state(short_strike=8.0, long_strike=7.0, net_credit=0.22, max_loss=0.78):
    """Build a populated spread_active state dict for tests."""
    return {
        "stage": "spread_active",
        "spread_type": "put_credit",
        "short_leg": {"occ": "PLTR260619P00008000", "strike": short_strike,
                      "entry_premium": 0.33, "qty": 1},
        "long_leg":  {"occ": "PLTR260619P00007000", "strike": long_strike,
                      "entry_premium": 0.11, "qty": 1},
        "expiration": "2026-06-19",
        "net_credit": net_credit,
        "max_loss": max_loss,
        "width": short_strike - long_strike,
        "opened_at": "2026-05-14T17:00:00Z",
        "total_premium_collected": 0.0,
        "cycle_count": 0,
        "cycle_history": [],
        "last_action": "",
    }


def test_compute_spread_pnl_at_open():
    """Right after open: short price = entry, long price = entry, current
    value = net_credit, profit_pct = 0."""
    sym_state = _spread_state(net_credit=0.22, max_loss=0.78)
    result = wheel_strategy._compute_spread_pnl(sym_state, short_mid=0.33, long_mid=0.11)
    assert result["current_value"] == pytest.approx(0.22)
    assert result["profit_pct"] == pytest.approx(0.0)
    assert result["loss_per_share"] == pytest.approx(0.0)


def test_compute_spread_pnl_50pct_profit():
    """Spread worth half of entry credit → 50% profit captured."""
    sym_state = _spread_state(net_credit=0.22, max_loss=0.78)
    # short dropped from 0.33 to 0.18, long dropped from 0.11 to 0.07
    # current value = 0.18 - 0.07 = 0.11 = half of 0.22 credit
    result = wheel_strategy._compute_spread_pnl(sym_state, short_mid=0.18, long_mid=0.07)
    assert result["current_value"] == pytest.approx(0.11)
    assert result["profit_pct"] == pytest.approx(0.50)
    assert result["loss_per_share"] == pytest.approx(-0.11)


def test_compute_spread_pnl_half_max_loss():
    """Loss per share = max_loss / 2 → stop loss should trigger."""
    sym_state = _spread_state(net_credit=0.22, max_loss=0.78)
    # current_value = 0.22 + 0.39 = 0.61 (loss = 0.39, half of 0.78)
    result = wheel_strategy._compute_spread_pnl(sym_state, short_mid=0.70, long_mid=0.09)
    assert result["current_value"] == pytest.approx(0.61)
    assert result["loss_per_share"] == pytest.approx(0.39)
    assert result["profit_pct"] < 0  # losing


def test_compute_spread_pnl_max_loss_floor():
    """Stock crashed — spread is worth the full width, max loss realized."""
    sym_state = _spread_state(short_strike=8.0, long_strike=7.0, net_credit=0.22, max_loss=0.78)
    # short = 1.50, long = 0.50, current_value = 1.00 = width
    result = wheel_strategy._compute_spread_pnl(sym_state, short_mid=1.50, long_mid=0.50)
    assert result["current_value"] == pytest.approx(1.00)
    assert result["loss_per_share"] == pytest.approx(0.78)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: FAIL with `AttributeError: module 'wheel_strategy' has no attribute '_compute_spread_pnl'`.

- [ ] **Step 3: Implement `_compute_spread_pnl`**

In `wheel_strategy.py`, find the end of `_empty_spread_state()` (around line 220 post-Phase-1). Immediately after the closing brace of its returned dict, add a new section:

```python


# ── Spread management (Phase 2) ──────────────────────────────────────────

def _compute_spread_pnl(sym_state: dict, short_mid: float, long_mid: float) -> dict:
    """Compute spread P&L from current option mid prices.

    Args:
      sym_state: state dict with shape from _empty_spread_state, must have
                 `net_credit` and `max_loss` populated.
      short_mid: current mid price of the short leg (per share).
      long_mid: current mid price of the long leg (per share).

    Returns:
      dict with keys:
        current_value:  cost-to-close per share (short - long)
        profit_pct:     fraction of credit captured. Positive when winning,
                        negative when losing. 0.50 means half the credit
                        has been captured (50% profit close trigger).
        loss_per_share: current loss in $/share. Positive when losing,
                        negative when winning. Compare against
                        max_loss * stop_loss_pct for stop-out check.
    """
    net_credit = float(sym_state["net_credit"])
    current_value = short_mid - long_mid
    profit_pct = (net_credit - current_value) / net_credit if net_credit > 0 else 0.0
    loss_per_share = current_value - net_credit
    return {
        "current_value": round(current_value, 4),
        "profit_pct": round(profit_pct, 4),
        "loss_per_share": round(loss_per_share, 4),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: 4 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 280 → 284 tests passing.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "wheel: add _compute_spread_pnl pure helper for spread P&L"
```

---

### Task 4: `place_sell_to_close` helper (long-leg close, no existing equivalent)

**Files:**
- Modify: `wheel_strategy.py` — insert immediately after `place_buy_to_close` (around line 505)
- Test: `tests/test_spread_management.py`

**Background:** Phase 1 only ever needed `place_buy_to_close` (closing short positions). Spread close needs to sell-to-close the long hedge leg, which has no existing helper. This task adds the symmetric function.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_spread_management.py`:

```python
def test_place_sell_to_close_calls_alpaca_with_correct_payload(monkeypatch):
    captured = {}
    def fake_api_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"id": "test-order-123", "symbol": body["symbol"]}
    monkeypatch.setattr(wheel_strategy, "api_post", fake_api_post)

    result = wheel_strategy.place_sell_to_close("PLTR260619P00007000", 0.10, qty=1)

    assert captured["path"] == "/orders"
    assert captured["body"]["symbol"] == "PLTR260619P00007000"
    assert captured["body"]["qty"] == "1"
    assert captured["body"]["side"] == "sell"
    assert captured["body"]["type"] == "limit"
    assert captured["body"]["position_intent"] == "sell_to_close"
    assert captured["body"]["time_in_force"] == "day"
    # Limit price should be slightly below mid to ensure fill — mirrors
    # place_buy_to_close which adds 0.05 above mid for the same reason.
    limit = float(captured["body"]["limit_price"])
    assert 0.04 <= limit <= 0.06  # mid 0.10, "slightly aggressive" subtraction
    assert result["id"] == "test-order-123"


def test_place_sell_to_close_auto_lookup_qty(monkeypatch):
    """When qty=None, the helper looks up the actual long position size."""
    monkeypatch.setattr(wheel_strategy, "get_option_position",
                        lambda sym: {"symbol": sym, "qty": "2"})
    captured = {}
    monkeypatch.setattr(wheel_strategy, "api_post",
                        lambda path, body: captured.update(body) or {"id": "x"})

    wheel_strategy.place_sell_to_close("PLTR260619P00007000", 0.10)
    assert captured["qty"] == "2"


def test_place_sell_to_close_skips_when_no_position(monkeypatch):
    """If Alpaca shows no position, the helper logs and returns None
    without placing an order."""
    monkeypatch.setattr(wheel_strategy, "get_option_position", lambda sym: None)
    placed = []
    monkeypatch.setattr(wheel_strategy, "api_post",
                        lambda path, body: placed.append(body))

    result = wheel_strategy.place_sell_to_close("PLTR260619P00007000", 0.10)
    assert result is None
    assert placed == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py::test_place_sell_to_close_calls_alpaca_with_correct_payload -v`

Expected: FAIL with `AttributeError: module 'wheel_strategy' has no attribute 'place_sell_to_close'`.

- [ ] **Step 3: Implement `place_sell_to_close`**

In `wheel_strategy.py`, find the end of `place_buy_to_close()` (around line 505). Immediately after it, add:

```python
def place_sell_to_close(option_symbol, limit_price, qty=None):
    """Sell-to-close a long option position.

    Mirror of place_buy_to_close — used to close the long hedge leg of a
    credit spread when the fallback close path runs (mleg rejected or
    orphan-leg recovery).

    qty: number of contracts to close. If None (default), looks up the
    actual long position size on Alpaca and closes ALL of it.

    Limit price is set slightly BELOW mid (subtract 0.05) to ensure a
    quick fill — symmetric to place_buy_to_close's "add 0.05" tactic.
    """
    if qty is None:
        pos = get_option_position(option_symbol)
        if pos is None:
            log(f"place_sell_to_close: no Alpaca position for {option_symbol} — skipping")
            return None
        qty = abs(int(float(pos.get("qty", 0))))
        if qty == 0:
            log(f"place_sell_to_close: position qty=0 for {option_symbol} — skipping")
            return None

    aggressive_limit = round(max(0.01, limit_price - 0.05), 2)
    order = api_post("/orders", {
        "symbol":          option_symbol,
        "qty":             str(qty),
        "side":            "sell",
        "type":            "limit",
        "limit_price":     str(aggressive_limit),
        "time_in_force":   "day",
        "position_intent": "sell_to_close",
    })
    log(f"Sell-to-close placed: {option_symbol} qty={qty} @ ${aggressive_limit:.2f} — order {order['id']}")
    return order
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: 7 tests pass (4 existing + 3 new).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 284 → 287 tests passing.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "wheel: add place_sell_to_close helper for closing long option legs"
```

---

### Task 5: `_close_spread_mleg` — multi-leg order submission

**Files:**
- Modify: `wheel_strategy.py` — insert after `_compute_spread_pnl`
- Test: `tests/test_spread_management.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_spread_management.py`:

```python
def test_close_spread_mleg_builds_correct_payload(monkeypatch):
    """Multi-leg buy-to-close payload: order_class=mleg, two legs with
    correct sides and position_intents, qty in spread units."""
    captured = {}
    def fake_api_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"id": "mleg-order-1", "status": "accepted"}
    monkeypatch.setattr(wheel_strategy, "api_post", fake_api_post)

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_mleg(sym_state)

    assert result is True
    assert captured["path"] == "/orders"
    body = captured["body"]
    assert body["order_class"] == "mleg"
    assert body["qty"] == "1"
    assert body["type"] == "market"
    assert body["time_in_force"] == "day"
    legs = body["legs"]
    assert len(legs) == 2
    # Find each leg by symbol
    short_leg = next(l for l in legs if l["symbol"] == "PLTR260619P00008000")
    long_leg  = next(l for l in legs if l["symbol"] == "PLTR260619P00007000")
    assert short_leg["side"] == "buy"
    assert short_leg["position_intent"] == "buy_to_close"
    assert short_leg["ratio_qty"] == "1"
    assert long_leg["side"] == "sell"
    assert long_leg["position_intent"] == "sell_to_close"
    assert long_leg["ratio_qty"] == "1"


def test_close_spread_mleg_returns_false_on_rejection(monkeypatch):
    """Alpaca rejection (any exception during api_post) returns False
    so the caller can try the fallback path."""
    def fake_api_post(path, body):
        raise RuntimeError("422 multi-leg order rejected")
    monkeypatch.setattr(wheel_strategy, "api_post", fake_api_post)

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_mleg(sym_state)
    assert result is False


def test_close_spread_mleg_handles_multi_contract_spreads(monkeypatch):
    """Spread with qty=2 → mleg payload qty='2', ratio_qty stays '1'
    (ratio is per-spread, not per-contract count)."""
    captured = {}
    monkeypatch.setattr(wheel_strategy, "api_post",
                        lambda path, body: captured.update(body) or {"id": "x"})

    sym_state = _spread_state()
    sym_state["short_leg"]["qty"] = 2
    sym_state["long_leg"]["qty"] = 2

    wheel_strategy._close_spread_mleg(sym_state)
    assert captured["qty"] == "2"
    assert all(leg["ratio_qty"] == "1" for leg in captured["legs"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py::test_close_spread_mleg_builds_correct_payload -v`

Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `_close_spread_mleg`**

In `wheel_strategy.py`, immediately after `_compute_spread_pnl`, add:

```python
def _close_spread_mleg(sym_state: dict) -> bool:
    """Submit an Alpaca multi-leg buy-to-close order for the spread.

    Returns True on success, False on any failure (rejection, network,
    timeout). The caller (_close_spread) decides whether to fall back
    to two individual orders.

    qty is in spread units (number of spreads), not per-leg. ratio_qty
    is the per-spread leg multiplier — always "1" for vertical spreads.
    """
    try:
        short_occ = sym_state["short_leg"]["occ"]
        long_occ  = sym_state["long_leg"]["occ"]
        qty       = sym_state["short_leg"]["qty"]  # short and long match by definition
        order = api_post("/orders", {
            "order_class":   "mleg",
            "qty":           str(qty),
            "type":          "market",
            "time_in_force": "day",
            "legs": [
                {"symbol": short_occ, "side": "buy",  "ratio_qty": "1", "position_intent": "buy_to_close"},
                {"symbol": long_occ,  "side": "sell", "ratio_qty": "1", "position_intent": "sell_to_close"},
            ],
        })
        log(f"Spread mleg close placed: short={short_occ} long={long_occ} qty={qty} — order {order.get('id', '?')}")
        return True
    except Exception as e:
        log(f"_close_spread_mleg failed: {type(e).__name__}: {e}")
        return False
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: 10 tests pass (7 existing + 3 new).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 287 → 290 tests passing.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "wheel: add _close_spread_mleg multi-leg order submission"
```

---

### Task 6: `_close_spread_legs_individually` — fallback path

**Files:**
- Modify: `wheel_strategy.py` — insert after `_close_spread_mleg`
- Test: `tests/test_spread_management.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spread_management.py`:

```python
def test_close_spread_legs_individually_both_succeed(monkeypatch):
    """Happy path: buy-to-close short, then sell-to-close long. Both succeed."""
    calls = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: calls.append(("btc", sym, qty)) or {"id": "a"})
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: calls.append(("stc", sym, qty)) or {"id": "b"})
    # Mock get_option_quote so the helper can compute limit prices
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_legs_individually(sym_state)

    assert result is True
    assert calls[0][0] == "btc"  # short closed first
    assert calls[0][1] == "PLTR260619P00008000"
    assert calls[1][0] == "stc"
    assert calls[1][1] == "PLTR260619P00007000"


def test_close_spread_legs_individually_short_fails(monkeypatch):
    """Short BTC fails → return False, do NOT attempt long STC.
    State is unchanged so next cycle retries from the top."""
    stc_called = []
    def failing_btc(sym, price, qty=None):
        raise RuntimeError("buy-to-close rejected")
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close", failing_btc)
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: stc_called.append(sym) or {"id": "b"})
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_legs_individually(sym_state)
    assert result is False
    assert stc_called == [], "long leg STC must not run when short BTC fails"


def test_close_spread_legs_individually_long_fails_marks_orphan(monkeypatch):
    """Short closes successfully, but long STC fails → return False AND
    mark short_leg.qty=0 in state so the next cycle's orphan handler
    closes the surviving long."""
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: {"id": "btc-1"})
    def failing_stc(sym, price, qty=None):
        raise RuntimeError("sell-to-close rejected")
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close", failing_stc)
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_legs_individually(sym_state)
    assert result is False
    # Half-closed marker so orphan handler picks up the long next cycle
    assert sym_state["short_leg"]["qty"] == 0
    assert sym_state["long_leg"]["qty"] == 1  # untouched


def test_close_spread_legs_individually_handles_missing_quote(monkeypatch):
    """If get_option_quote returns None (no live quote), use the entry
    premium as a fallback limit reference so we still attempt the close."""
    calls = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: calls.append(price) or {"id": "a"})
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: calls.append(price) or {"id": "b"})
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: None)

    sym_state = _spread_state()  # short_entry 0.33, long_entry 0.11
    wheel_strategy._close_spread_legs_individually(sym_state)
    # Fallback uses entry_premium values
    assert calls[0] == pytest.approx(0.33)
    assert calls[1] == pytest.approx(0.11)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py::test_close_spread_legs_individually_both_succeed -v`

Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `_close_spread_legs_individually`**

In `wheel_strategy.py`, immediately after `_close_spread_mleg`, add:

```python
def _close_spread_legs_individually(sym_state: dict) -> bool:
    """Fallback close path: place two separate single-leg orders.

    Order is critical:
      1. Buy-to-close the SHORT leg first (eliminates assignment risk)
      2. Sell-to-close the LONG leg

    If step 1 fails, return False without touching state — next cycle
    retries from handle_spread's top.

    If step 1 succeeds but step 2 fails, the spread is in a half-closed
    state: short is gone, long is orphaned. Mark short_leg.qty=0 so the
    next cycle's _handle_orphan_leg sees "long present, short missing"
    and closes the survivor.

    Limit prices: midpoint from get_option_quote if available, otherwise
    the entry premium as a fallback (better than no order at all).
    """
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]
    short_entry = sym_state["short_leg"]["entry_premium"]
    long_entry  = sym_state["long_leg"]["entry_premium"]

    def _mid_or_entry(occ: str, entry: float) -> float:
        q = get_option_quote(occ)
        if q:
            return round((q["bid"] + q["ask"]) / 2, 2)
        return entry

    short_limit = _mid_or_entry(short_occ, short_entry)
    long_limit  = _mid_or_entry(long_occ,  long_entry)

    # Step 1: close the short leg
    try:
        place_buy_to_close(short_occ, short_limit)
    except Exception as e:
        log(f"_close_spread_legs_individually: BTC failed on {short_occ}: {type(e).__name__}: {e}")
        send_embed(
            ERRORS_CH, f"Spread close failed (short leg) {sym_state.get('spread_type', '?')}",
            color=Color.RED,
            description=(
                f"BTC of short leg `{short_occ}` failed: {e}. "
                f"Spread is intact; next cycle will retry."
            ),
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        return False

    # Step 2: close the long leg
    try:
        place_sell_to_close(long_occ, long_limit)
    except Exception as e:
        log(f"_close_spread_legs_individually: STC failed on {long_occ}: {type(e).__name__}: {e}")
        # Half-closed: mark short as gone so orphan handler picks up the long
        sym_state["short_leg"]["qty"] = 0
        send_embed(
            ERRORS_CH, f"Spread close ORPHANED",
            color=Color.RED,
            description=(
                f"Short leg `{short_occ}` closed successfully, but STC of "
                f"long leg `{long_occ}` failed: {e}. "
                f"Next cycle's orphan handler will retry the long-leg close."
            ),
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        return False

    return True
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: 14 tests pass (10 existing + 4 new).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 290 → 294 tests passing.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "wheel: add _close_spread_legs_individually fallback close path"
```

---

### Task 7: `_close_spread` orchestrator (mleg first, fall back to singles)

**Files:**
- Modify: `wheel_strategy.py` — insert after `_close_spread_legs_individually`
- Test: `tests/test_spread_management.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spread_management.py`:

```python
def test_close_spread_mleg_success_deletes_state(monkeypatch):
    """mleg succeeds → state[ticker] deleted, single trades-channel embed."""
    monkeypatch.setattr(wheel_strategy, "_close_spread_mleg", lambda ss: True)
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((ch, title, kw)))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    wheel_strategy._close_spread(state, "PLTR", reason="early_close_50pct")

    assert "PLTR" not in state, "state entry must be deleted on successful close"
    assert any("closed spread" in title.lower() for ch, title, kw in embeds)


def test_close_spread_falls_back_to_singles_on_mleg_failure(monkeypatch):
    """mleg fails → fallback path tried. If fallback succeeds, state is
    deleted and the trades embed footer notes the fallback."""
    monkeypatch.setattr(wheel_strategy, "_close_spread_mleg", lambda ss: False)
    monkeypatch.setattr(wheel_strategy, "_close_spread_legs_individually", lambda ss: True)
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((ch, title, kw)))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    wheel_strategy._close_spread(state, "PLTR", reason="stop_loss_50pct")

    assert "PLTR" not in state
    # An info embed about the fallback should land in #actions
    assert any("fallback" in (kw.get("description") or "").lower()
               for ch, title, kw in embeds)


def test_close_spread_both_paths_fail_leaves_state_alone(monkeypatch):
    """Both mleg AND fallback fail → state untouched, error already
    surfaced by the fallback path. Next cycle retries."""
    monkeypatch.setattr(wheel_strategy, "_close_spread_mleg", lambda ss: False)
    monkeypatch.setattr(wheel_strategy, "_close_spread_legs_individually", lambda ss: False)
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    wheel_strategy._close_spread(state, "PLTR", reason="stop_loss_50pct")

    assert "PLTR" in state, "state must remain so next cycle can retry"


def test_close_spread_embed_color_by_reason(monkeypatch):
    """Profit close → green; stop loss / DTE close → yellow."""
    monkeypatch.setattr(wheel_strategy, "_close_spread_mleg", lambda ss: True)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    for reason, expected_color in (
        ("early_close_50pct", wheel_strategy.Color.GREEN),
        ("stop_loss_50pct",   wheel_strategy.Color.YELLOW),
        ("dte_floor_itm",     wheel_strategy.Color.YELLOW),
    ):
        captured = []
        monkeypatch.setattr(wheel_strategy, "send_embed",
                            lambda ch, title, **kw: captured.append(kw.get("color")))
        state = {"PLTR": _spread_state()}
        wheel_strategy._close_spread(state, "PLTR", reason=reason)
        assert expected_color in captured, f"reason={reason} missing color {expected_color}"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py::test_close_spread_mleg_success_deletes_state -v`

Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `_close_spread`**

In `wheel_strategy.py`, immediately after `_close_spread_legs_individually`, add:

```python
def _close_spread(state: dict, ticker: str, reason: str) -> None:
    """Orchestrate a spread close: try mleg first, fall back to two singles.

    On success:
      - Delete state[ticker] entirely (clean removal; not preserved like
        single-leg wheel cycles which keep cycle_history).
      - Fire #trades embed (color depends on reason).
      - Mirror to #actions.
      - JSONL `spread_closed` event with reason and close details.

    On failure of BOTH paths:
      - Leave state intact (next cycle retries).
      - Error embed already surfaced by _close_spread_legs_individually.

    Reasons:
      - "early_close_50pct" → green, "closed spread … at 50% profit"
      - "stop_loss_50pct"   → yellow, "stopped out spread …"
      - "dte_floor_itm"     → yellow, "closed spread … near expiration (ITM risk)"
    """
    sym_state = state[ticker]
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]

    used_fallback = False
    if _close_spread_mleg(sym_state):
        success = True
    else:
        used_fallback = True
        success = _close_spread_legs_individually(sym_state)

    if not success:
        # Error already surfaced by the fallback path; leave state alone.
        return

    # Map reason → presentation
    title_map = {
        "early_close_50pct": f"Wheel: closed spread {ticker} at 50% profit",
        "stop_loss_50pct":   f"Wheel: stopped out spread {ticker}",
        "dte_floor_itm":     f"Wheel: closed spread {ticker} near expiration (ITM risk)",
    }
    color_map = {
        "early_close_50pct": Color.GREEN,
        "stop_loss_50pct":   Color.YELLOW,
        "dte_floor_itm":     Color.YELLOW,
    }
    title = title_map.get(reason, f"Wheel: closed spread {ticker}")
    color = color_map.get(reason, Color.YELLOW)

    description = (
        f"{sym_state['spread_type'].replace('_', ' ')} on {ticker}: "
        f"short={short_occ}, long={long_occ}, "
        f"net_credit=${sym_state['net_credit']:.2f}, max_loss=${sym_state['max_loss']:.2f}."
    )
    footer = f"wheel_strategy.py · {MODE}"
    send_embed(TRADES_CH, title, color=color, description=description,
               footer=footer, actions_channel=ACTIONS_CH)

    if used_fallback:
        send_embed(
            ACTIONS_CH, f"Spread close used fallback path ({ticker})",
            color=Color.BLUE,
            description=(
                f"mleg order was rejected; closed legs individually. "
                f"Spread on {ticker} is fully closed."
            ),
            footer=footer,
        )

    log_event(LOG_STREAM, "wheel_strategy.py", "spread_closed",
              symbol=ticker,
              details={
                  "reason": reason,
                  "spread_type": sym_state["spread_type"],
                  "short_occ": short_occ,
                  "long_occ":  long_occ,
                  "net_credit": sym_state["net_credit"],
                  "max_loss": sym_state["max_loss"],
                  "fallback_used": used_fallback,
              })

    del state[ticker]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: 18 tests pass (14 existing + 4 new).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 294 → 298 tests passing.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "wheel: add _close_spread orchestrator (mleg with single-leg fallback)"
```

---

### Task 8: `_handle_orphan_leg` — half-state recovery

**Files:**
- Modify: `wheel_strategy.py` — insert after `_close_spread`
- Test: `tests/test_spread_management.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spread_management.py`:

```python
def _stock_pos(symbol, qty):
    return {"symbol": symbol, "asset_class": "us_equity",
            "qty": str(qty), "avg_entry_price": "10.0"}


def test_orphan_short_missing_closes_long(monkeypatch):
    """Short leg gone from Alpaca, long leg still present → STC the
    long, delete state, embed says 'short leg gone'."""
    captured = []
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: captured.append(("stc", sym)) or {"id": "x"})
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: captured.append(("btc", sym)) or {"id": "x"})
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.05, "ask": 0.07})
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((title, kw.get("description", ""))))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    positions = [
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option",
         "qty": "1", "avg_entry_price": "0.11"},
    ]

    wheel_strategy._handle_orphan_leg(state, "PLTR", positions)

    assert ("stc", "PLTR260619P00007000") in captured
    assert ("btc", "PLTR260619P00008000") not in captured
    assert "PLTR" not in state
    assert any("short leg gone" in d.lower() for t, d in embeds)


def test_orphan_long_missing_closes_short(monkeypatch):
    """Long leg gone from Alpaca, short leg still present → BTC the
    short, delete state, embed says 'long leg gone'."""
    captured = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: captured.append(sym) or {"id": "x"})
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: captured.append(("BAD", sym)))
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((title, kw.get("description", ""))))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    positions = [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option",
         "qty": "-1", "avg_entry_price": "-0.33"},
    ]

    wheel_strategy._handle_orphan_leg(state, "PLTR", positions)

    assert "PLTR260619P00008000" in captured
    assert "PLTR" not in state
    assert any("long leg gone" in d.lower() for t, d in embeds)


def test_orphan_both_missing_clears_state(monkeypatch):
    """Both legs gone (closed externally between cycles) → no orders,
    delete state, embed says 'fully closed externally'."""
    orders = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda *a, **kw: orders.append("btc"))
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda *a, **kw: orders.append("stc"))
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((title, kw.get("description", ""))))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    wheel_strategy._handle_orphan_leg(state, "PLTR", positions=[])

    assert orders == []
    assert "PLTR" not in state
    assert any("fully closed externally" in d.lower() for t, d in embeds)


def test_orphan_returns_early_when_both_legs_present(monkeypatch):
    """Sanity: if both legs are still in positions, the orphan handler
    must NOT do anything. (handle_spread is supposed to gate this, but
    test the helper standalone.)"""
    orders = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda *a, **kw: orders.append("btc"))
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda *a, **kw: orders.append("stc"))
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    positions = [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option",
         "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option",
         "qty": "1", "avg_entry_price": "0.11"},
    ]
    wheel_strategy._handle_orphan_leg(state, "PLTR", positions)

    assert orders == []
    assert "PLTR" in state, "state must not be touched when both legs present"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py::test_orphan_short_missing_closes_long -v`

Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `_handle_orphan_leg`**

In `wheel_strategy.py`, immediately after `_close_spread`, add:

```python
def _handle_orphan_leg(state: dict, ticker: str, positions: list) -> None:
    """Resolve a spread half-state.

    Called by handle_spread when state[ticker]["stage"] == "spread_active"
    but Alpaca's positions show only one (or neither) leg.

    Behaviors:
      - Short missing, long present → STC the long; delete state.
      - Long missing, short present → BTC the short; delete state.
      - Both missing → delete state; no orders.
      - Both present → no-op (caller should not have called this).
    """
    sym_state = state[ticker]
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]

    occs_present = {p["symbol"] for p in positions
                    if p.get("asset_class") == "us_option"}
    short_present = short_occ in occs_present
    long_present  = long_occ  in occs_present

    if short_present and long_present:
        return  # caller error; nothing to do here

    def _mid_or_entry(occ: str, entry: float) -> float:
        q = get_option_quote(occ)
        if q:
            return round((q["bid"] + q["ask"]) / 2, 2)
        return entry

    if short_present and not long_present:
        # Long leg gone (expired alone, manually closed, etc.) — BTC the short
        try:
            place_buy_to_close(short_occ, _mid_or_entry(short_occ, sym_state["short_leg"]["entry_premium"]))
            description = (
                f"Long leg gone from Alpaca; bought-to-close remaining short "
                f"`{short_occ}` to clean up the orphan."
            )
            send_embed(TRADES_CH, f"Wheel: spread half-state resolved {ticker}",
                       color=Color.YELLOW, description=description,
                       footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
            log_event(LOG_STREAM, "wheel_strategy.py", "spread_orphan_resolved",
                      symbol=ticker,
                      details={"surviving_leg": "short", "occ": short_occ})
            del state[ticker]
        except Exception as e:
            log(f"_handle_orphan_leg short BTC failed: {type(e).__name__}: {e}")
            send_embed(ERRORS_CH, f"Orphan resolution failed for {ticker}",
                       color=Color.RED,
                       description=f"BTC of {short_occ} failed: {e}. State left intact for retry.",
                       footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
        return

    if long_present and not short_present:
        # Short leg gone (assigned overnight, etc.) — STC the long
        try:
            place_sell_to_close(long_occ, _mid_or_entry(long_occ, sym_state["long_leg"]["entry_premium"]))
            description = (
                f"Short leg gone from Alpaca; sold-to-close remaining long "
                f"`{long_occ}` to clean up the orphan."
            )
            send_embed(TRADES_CH, f"Wheel: spread half-state resolved {ticker}",
                       color=Color.YELLOW, description=description,
                       footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
            log_event(LOG_STREAM, "wheel_strategy.py", "spread_orphan_resolved",
                      symbol=ticker,
                      details={"surviving_leg": "long", "occ": long_occ})
            del state[ticker]
        except Exception as e:
            log(f"_handle_orphan_leg long STC failed: {type(e).__name__}: {e}")
            send_embed(ERRORS_CH, f"Orphan resolution failed for {ticker}",
                       color=Color.RED,
                       description=f"STC of {long_occ} failed: {e}. State left intact for retry.",
                       footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
        return

    # Both missing — no orders, just clear state
    send_embed(TRADES_CH, f"Wheel: spread {ticker} fully closed externally",
               color=Color.YELLOW,
               description=(
                   f"Both legs of the spread on {ticker} are gone from Alpaca. "
                   f"State cleared; no orders placed."
               ),
               footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
    log_event(LOG_STREAM, "wheel_strategy.py", "spread_orphan_resolved",
              symbol=ticker, details={"surviving_leg": "none"})
    del state[ticker]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: 22 tests pass (18 existing + 4 new).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 298 → 302 tests passing.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "wheel: add _handle_orphan_leg for spread half-state recovery"
```

---

### Task 9: `handle_spread` decision tree

**Files:**
- Modify: `wheel_strategy.py` — insert after `_handle_orphan_leg`
- Test: `tests/test_spread_management.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spread_management.py`:

```python
from datetime import date as _date_type, timedelta as _timedelta


def _far_expiry_state(**kwargs):
    """Spread state with expiration well in the future (no DTE trigger risk)."""
    s = _spread_state(**kwargs)
    far = _date_type.today() + _timedelta(days=30)
    s["expiration"] = far.isoformat()
    return s


def _near_expiry_state(days_to_expiry=2, **kwargs):
    s = _spread_state(**kwargs)
    near = _date_type.today() + _timedelta(days=days_to_expiry)
    s["expiration"] = near.isoformat()
    return s


def test_handle_spread_profit_50pct_triggers_close(monkeypatch):
    """Spread at 50% profit → _close_spread called with early_close_50pct."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.17, "ask": 0.19},  # mid 0.18
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},  # mid 0.07
    }[sym])
    # Profit calc: current_value = 0.18 - 0.07 = 0.11, credit was 0.22 → 50% profit
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "early_close_50pct")]


def test_handle_spread_stop_loss_triggers_close(monkeypatch):
    """Loss per share >= 50% of max_loss → stop_loss_50pct."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # current_value = 0.70 - 0.09 = 0.61. loss = 0.61 - 0.22 = 0.39 = 50% of 0.78
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.69, "ask": 0.71},
        "PLTR260619P00007000": {"bid": 0.08, "ask": 0.10},
    }[sym])
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "stop_loss_50pct")]


def test_handle_spread_dte_floor_with_itm_triggers_close(monkeypatch):
    """DTE <=2 AND short put ITM → dte_floor_itm close."""
    state = {"PLTR": _near_expiry_state(days_to_expiry=2)}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # Not at profit, not at stop loss — pure DTE close case
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.30, "ask": 0.32},
        "PLTR260619P00007000": {"bid": 0.10, "ask": 0.12},
    }[sym])
    # Stock price 7.50 < short strike 8.0 → ITM (put credit short ITM)
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 7.50)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "dte_floor_itm")]


def test_handle_spread_dte_floor_when_otm_holds(monkeypatch):
    """DTE <=2 but short put OTM → hold, no close."""
    state = {"PLTR": _near_expiry_state(days_to_expiry=2)}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.30, "ask": 0.32},
        "PLTR260619P00007000": {"bid": 0.10, "ask": 0.12},
    }[sym])
    # Stock price 9.0 > short strike 8.0 → OTM (safe)
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == []


def test_handle_spread_call_credit_dte_itm(monkeypatch):
    """For call_credit spreads, ITM means stock > short_strike."""
    state = {"PLTR": _near_expiry_state(days_to_expiry=2)}
    state["PLTR"]["spread_type"] = "call_credit"
    state["PLTR"]["short_leg"] = {"occ": "PLTR260619C00010000", "strike": 10.0,
                                   "entry_premium": 0.40, "qty": 1}
    state["PLTR"]["long_leg"]  = {"occ": "PLTR260619C00011000", "strike": 11.0,
                                   "entry_premium": 0.15, "qty": 1}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619C00010000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.40"},
        {"symbol": "PLTR260619C00011000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.15"},
    ])
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619C00010000": {"bid": 0.40, "ask": 0.42},
        "PLTR260619C00011000": {"bid": 0.15, "ask": 0.17},
    }[sym])
    # Stock 10.50 > short strike 10.0 → ITM for short call
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 10.50)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "dte_floor_itm")]


def test_handle_spread_no_triggers_holds(monkeypatch):
    """All triggers negative → hold, no close, no state change."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # Profit ~20%, not at 50%
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.25, "ask": 0.27},
        "PLTR260619P00007000": {"bid": 0.08, "ask": 0.10},
    }[sym])
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == []
    assert "PLTR" in state


def test_handle_spread_orphan_routes_to_handler(monkeypatch):
    """Only one leg present on Alpaca → _handle_orphan_leg fires, NOT _close_spread."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        # only the long leg present
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    orphan_calls = []
    close_calls = []
    monkeypatch.setattr(wheel_strategy, "_handle_orphan_leg",
                        lambda state, ticker, positions: orphan_calls.append(ticker))
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: close_calls.append(ticker))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert orphan_calls == ["PLTR"]
    assert close_calls == []


def test_handle_spread_profit_takes_priority_over_dte(monkeypatch):
    """If a spread is BOTH at 50% profit AND at DTE <=2 with ITM short,
    profit takes priority (better outcome for the trader)."""
    state = {"PLTR": _near_expiry_state(days_to_expiry=1)}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # current_value = 0.11 = 50% of credit
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.17, "ask": 0.19},
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},
    }[sym])
    # Stock 7.5 < short strike 8.0 → ITM, but profit trigger fires first
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 7.5)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "early_close_50pct")]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py::test_handle_spread_profit_50pct_triggers_close -v`

Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `handle_spread`**

In `wheel_strategy.py`, immediately after `_handle_orphan_leg`, add:

```python
def handle_spread(state: dict, ticker: str, account: dict) -> None:
    """Per-cycle decision function for an active spread.

    Mirror of handle_stage1 / handle_stage2. Called by run_wheel when
    state[ticker]["stage"] == "spread_active" and SPREAD_MANAGEMENT is True.

    Decision order (first trigger wins):
      1. Both legs gone or only one present → _handle_orphan_leg → return
      2. profit_pct >= early_close_pct       → _close_spread early_close_50pct
      3. loss >= max_loss * stop_loss_pct    → _close_spread stop_loss_50pct
      4. DTE <= dte_floor AND short leg ITM  → _close_spread dte_floor_itm
      5. otherwise                           → log heartbeat, no state change
    """
    sym_state = state[ticker]
    positions = get_positions()

    # 1. Orphan detection — before any snapshot fetch
    occs_present = {p["symbol"] for p in positions
                    if p.get("asset_class") == "us_option"}
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]
    if not (short_occ in occs_present and long_occ in occs_present):
        _handle_orphan_leg(state, ticker, positions)
        return

    # 2-4. Fetch current snapshots
    short_q = get_option_quote(short_occ)
    long_q  = get_option_quote(long_occ)
    if not short_q or not long_q:
        log(f"[{ticker}] spread heartbeat — missing quote, skipping cycle")
        return
    short_mid = round((short_q["bid"] + short_q["ask"]) / 2, 4)
    long_mid  = round((long_q["bid"]  + long_q["ask"])  / 2, 4)

    pnl = _compute_spread_pnl(sym_state, short_mid, long_mid)
    max_loss = float(sym_state["max_loss"])

    # 2. Profit trigger
    if pnl["profit_pct"] >= SPREAD_EARLY_CLOSE_PCT:
        log(f"[{ticker}] spread profit_pct={pnl['profit_pct']:.2%} >= "
            f"{SPREAD_EARLY_CLOSE_PCT:.0%} — closing at profit")
        _close_spread(state, ticker, reason="early_close_50pct")
        return

    # 3. Stop loss trigger
    if pnl["loss_per_share"] >= max_loss * SPREAD_STOP_LOSS_PCT:
        log(f"[{ticker}] spread loss=${pnl['loss_per_share']:.2f} >= "
            f"{SPREAD_STOP_LOSS_PCT:.0%} of max_loss=${max_loss:.2f} — stopping out")
        _close_spread(state, ticker, reason="stop_loss_50pct")
        return

    # 4. DTE floor with ITM check
    from datetime import date as _date
    expiry = _date.fromisoformat(sym_state["expiration"])
    days_to_expiry = (expiry - _date.today()).days
    if days_to_expiry <= SPREAD_DTE_FLOOR:
        short_strike = float(sym_state["short_leg"]["strike"])
        stock_price = get_latest_price(ticker)
        spread_type = sym_state["spread_type"]
        short_itm = (
            (spread_type == "put_credit"  and stock_price < short_strike) or
            (spread_type == "call_credit" and stock_price > short_strike)
        )
        if short_itm:
            log(f"[{ticker}] spread DTE={days_to_expiry} <= floor AND short leg ITM "
                f"(stock=${stock_price:.2f}, short_strike=${short_strike:.2f}) — closing")
            _close_spread(state, ticker, reason="dte_floor_itm")
            return

    # 5. Hold heartbeat
    log(f"[{ticker}] spread holding — profit {pnl['profit_pct']:.1%}, "
        f"loss ${pnl['loss_per_share']:.2f}, DTE {days_to_expiry}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: 30 tests pass (22 existing + 8 new).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`

Expected: 302 → 310 tests passing.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "wheel: add handle_spread decision tree (profit, stop loss, DTE close)"
```

---

### Task 10: Wire `handle_spread` into `run_wheel` with `SPREAD_MANAGEMENT` flag

**Files:**
- Modify: `wheel_strategy.py` — `apply_mode()`, module globals near top, `run_wheel()` loop
- Test: `tests/test_spread_management.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_spread_management.py`:

```python
def test_apply_mode_manual_enables_spread_management():
    """apply_mode('manual') sets SPREAD_MANAGEMENT to True and reads
    the three threshold globals from config."""
    import config
    wheel_strategy.apply_mode("manual")
    assert wheel_strategy.SPREAD_MANAGEMENT is True
    assert wheel_strategy.SPREAD_EARLY_CLOSE_PCT == 0.50
    assert wheel_strategy.SPREAD_STOP_LOSS_PCT == 0.50
    assert wheel_strategy.SPREAD_DTE_FLOOR == 2


def test_apply_mode_conservative_keeps_spread_management_off():
    wheel_strategy.apply_mode("conservative")
    assert wheel_strategy.SPREAD_MANAGEMENT is False


def test_run_wheel_routes_spread_to_handle_spread(monkeypatch, tmp_path):
    """Integration: when run_wheel sees a spread_active state entry on
    manual mode, it calls handle_spread (and not handle_stage1/2)."""
    import json
    wheel_strategy.apply_mode("manual")
    state = {"_meta": {}, "PLTR": _spread_state()}
    state_file = tmp_path / "wheel_state_manual.json"
    state_file.write_text(json.dumps(state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))

    monkeypatch.setattr(wheel_strategy, "is_market_open", lambda: True)
    monkeypatch.setattr(wheel_strategy, "get_account",
                        lambda: {"cash": "10000", "options_buying_power": "10000"})
    # Stub auto-discovery so SYMBOLS stays as just PLTR
    monkeypatch.setattr(wheel_strategy, "_discover_wheel_state",
                        lambda state: {"PLTR"})

    handled = []
    monkeypatch.setattr(wheel_strategy, "handle_spread",
                        lambda state, ticker, account: handled.append(ticker))
    stage1_handled = []
    stage2_handled = []
    monkeypatch.setattr(wheel_strategy, "handle_stage1",
                        lambda *a, **kw: stage1_handled.append(True))
    monkeypatch.setattr(wheel_strategy, "handle_stage2",
                        lambda *a, **kw: stage2_handled.append(True))

    wheel_strategy.run_wheel()

    assert handled == ["PLTR"]
    assert stage1_handled == []
    assert stage2_handled == []


def test_run_wheel_with_spread_management_off_skips_spread(monkeypatch, tmp_path):
    """If SPREAD_MANAGEMENT is False (e.g. on conservative mode), a
    spread_active entry is left alone — log heartbeat only, no handler call."""
    import json
    wheel_strategy.apply_mode("conservative")
    assert wheel_strategy.SPREAD_MANAGEMENT is False

    state = {"_meta": {}, "PLTR": _spread_state()}
    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))
    monkeypatch.setattr(wheel_strategy, "is_market_open", lambda: True)
    monkeypatch.setattr(wheel_strategy, "get_account",
                        lambda: {"cash": "100000", "options_buying_power": "100000"})
    monkeypatch.setattr(wheel_strategy, "_discover_wheel_state",
                        lambda state: {"PLTR"})

    handled = []
    monkeypatch.setattr(wheel_strategy, "handle_spread",
                        lambda state, ticker, account: handled.append(ticker))

    wheel_strategy.run_wheel()
    assert handled == [], "handle_spread must not be called when SPREAD_MANAGEMENT=False"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py::test_apply_mode_manual_enables_spread_management -v`

Expected: FAIL — `SPREAD_MANAGEMENT` global doesn't exist yet.

- [ ] **Step 3: Add the three new globals near the top of `wheel_strategy.py`**

Find the module-level globals block (around line 58-79, where `WHEEL_SKIP_NEW_PUTS` and `AUTO_DISCOVER_SYMBOLS` are defined). Add three more globals immediately after them:

```python
WHEEL_SKIP_NEW_PUTS  = False  # manual mode: never open Stage 1 puts
AUTO_DISCOVER_SYMBOLS = False  # manual mode: build SYMBOLS from Alpaca positions
SPREAD_MANAGEMENT     = False  # manual mode (Phase 2): manage adopted spreads
SPREAD_EARLY_CLOSE_PCT = 0.50
SPREAD_STOP_LOSS_PCT   = 0.50
SPREAD_DTE_FLOOR       = 2
```

- [ ] **Step 4: Update `apply_mode()` to populate the new globals**

In `apply_mode()`, find the `global` declarations block (around line 88-94). Add the new globals to the `global` statement:

```python
    global WHEEL_SKIP_NEW_PUTS, AUTO_DISCOVER_SYMBOLS
    global SPREAD_MANAGEMENT, SPREAD_EARLY_CLOSE_PCT, SPREAD_STOP_LOSS_PCT, SPREAD_DTE_FLOOR
```

Then at the end of the function (after `AUTO_DISCOVER_SYMBOLS = cfg.get("auto_discover_symbols", False)`), add:

```python
    SPREAD_MANAGEMENT      = cfg.get("spread_management", False)
    SPREAD_EARLY_CLOSE_PCT = cfg.get("spread_early_close_pct", 0.50)
    SPREAD_STOP_LOSS_PCT   = cfg.get("spread_stop_loss_pct", 0.50)
    SPREAD_DTE_FLOOR       = cfg.get("spread_dte_floor", 2)
```

- [ ] **Step 5: Add the routing branch in `run_wheel()`**

In `wheel_strategy.py`, find the `run_wheel()` function. It currently dispatches by `sym_state["stage"]` to either `handle_stage1` or `handle_stage2`. Find the inner loop that processes each symbol — it looks like:

```python
        for symbol in SYMBOLS:
            ...
            sym_state = state.setdefault(symbol, _empty_symbol_state())
            ...
            if sym_state["stage"] == 1:
                handle_stage1(...)
            elif sym_state["stage"] == 2:
                handle_stage2(...)
```

Before the `if sym_state["stage"] == 1:` line, insert a new branch:

```python
            if sym_state.get("stage") == "spread_active":
                if not SPREAD_MANAGEMENT:
                    log(f"[{symbol}] spread_active but SPREAD_MANAGEMENT=False — skipping")
                    continue
                handle_spread(state, symbol, account)
                continue
```

(Don't replace the existing `if stage == 1 / 2` branches — add the new branch above them.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -v`

Expected: All 34 pass (30 existing + 4 new).

- [ ] **Step 7: Run the full suite — CRITICAL regression check**

Run: `python -m pytest tests/ -v --tb=short`

Expected: All pass. The `test_manual_mode.py` and `test_wheel_assignment.py` files exercise the existing `run_wheel` dispatch logic — both must continue to pass. If they regress, the new branch is intercepting something it shouldn't (check the `.get("stage")` is used since some test states may lack the key).

- [ ] **Step 8: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "wheel: route spread_active state to handle_spread in run_wheel"
```

---

### Task 11: Documentation — update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Spread Detection section to reflect Phase 2 ship**

In `CLAUDE.md`, find the `### Spread detection (foundation only — no management yet)` section (added in Phase 1 Task 9). Replace the entire section with:

```markdown
### Spreads — detection (Phase 1) + management on manual (Phase 2)

`wheel_strategy.py` recognizes put credit spreads and call credit spreads at discovery time by pairing short+long option legs that share underlying, expiration, and option type. When multiple pairings are possible (e.g. you hold a bare CSP AND a spread on the same expiry), the **narrowest-width pair wins** — so the real spread is identified correctly and the bare CSP falls through to single-leg Stage 1 adoption. Paired legs are adopted into a dedicated `stage: "spread_active"` state shape with `short_leg` and `long_leg` blocks. `long_options_strategy.py` consults the wheel state file each cycle and skips any long option whose OCC is claimed by a spread.

**Management runs on manual paper only** (`config.MODES["manual"]["spread_management"] = True`). `handle_spread()` evaluates three close triggers in priority order, every cycle:

1. **Profit close** — buy-to-close at 50% of credit captured (`spread_early_close_pct: 0.50`)
2. **Stop loss** — buy-to-close at 50% of max loss (`spread_stop_loss_pct: 0.50`)
3. **DTE floor** — buy-to-close at ≤2 days to expiration IF the short leg is ITM (`spread_dte_floor: 2`)

Close mechanic: try Alpaca multi-leg (`order_class: mleg`) first; on rejection, fall back to two individual orders (buy-to-close short, sell-to-close long). If the short closes but the long fails, state is marked half-closed so the next cycle's orphan handler picks up the survivor. State is **deleted** on successful close (not preserved like single-leg wheel state — spreads are one-shot positions, not the rotating Stage 1 ↔ Stage 2 cycle).

**Orphan-leg handling**: if a tracked spread shows only one leg on Alpaca (manual close on the web UI, overnight assignment, expired alone, etc.), `_handle_orphan_leg` auto-closes the survivor at market and clears spread state.

**What's NOT yet implemented:**
- Live-mode wiring — `spread_management: False` on conservative, aggressive, AND live. A future plan flips live on after at least 2 weeks of manual paper validation.
- Daily summary spread section — `daily_summary.py` continues to ignore `spread_active` entries (no crash, no rendering).
- Dashboard order form for opening multi-leg spreads through Alpaca's `mleg` order class.
- Position-size guardrails (`min_account_floor`, `max_concurrent_spreads`) — only matter for the future live small-account plan.
- Auto-roll logic — Tim opted out; spreads close at trigger, no auto-rollover.
- Dashboard `rule-check.ts` still ignores `spread_active` when evaluating bot-wheel overlap on manual order placement — future enhancement, not a bug today.

**Known limitations:**
- Daily summary table will still misalign for `spread_active` rows (cosmetic, no crash).
- Split-fill long legs (`short_qty != long_qty`) won't pair — falls through to single-leg adoption.

Tracking plans:
- Phase 1 (foundation): [2026-05-14-spread-detection-foundation.md](docs/superpowers/plans/2026-05-14-spread-detection-foundation.md) (merged in [PR #9](https://github.com/tsronco/TradingBotTest-Claude/pull/9))
- Phase 2 (management): [2026-05-14-spread-management.md](docs/superpowers/plans/2026-05-14-spread-management.md)
- Spec: [2026-05-14-spread-management-design.md](docs/superpowers/specs/2026-05-14-spread-management-design.md)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update spread detection section to cover Phase 2 management"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

Run: `python -m pytest tests/ -v --tb=short`

Expected: All tests pass. End-of-plan count: 280 → ~314 tests (about 34 new vs. start of plan; 22 new in `test_spread_management.py`, 2 narrowest-width in `test_spread_detection.py`, 2 new in `test_config_modes.py`, plus 8 handle_spread + 4 routing = matches the per-task count).

- [ ] **Step 2: Smoke test on the manual paper account locally**

```bash
python wheel_strategy.py --mode manual
```

Behavior with no spread positions held: same as before this plan — auto-discovers single-leg positions, manages them. With a spread open on the manual paper account (open one via Alpaca web UI first if needed):
- A `Wheel: adopted spread PLTR` embed in `#manual-trades` (Phase 1 behavior, still works)
- On subsequent cycles, a heartbeat log line `[PLTR] spread holding — profit X%, loss Y, DTE Z`
- When profit hits 50% (or stop loss / DTE floor), a `Wheel: closed spread PLTR ...` embed and the state entry disappears

- [ ] **Step 3: PR**

Branch: `claude/spread-management-design` (created during spec brainstorming). Open PR against `main`.

PR description should include:
- Link to plan and spec
- Bullet list of what's covered (management on manual paper only) vs. what's still deferred (live, dashboard, summary)
- Test count delta
- Confirmation that `spread_management: True` only on manual; conservative/aggressive/live remain `False`
- Smoke-test results from step 2

---

## Self-review notes

- **Detection narrowest-width fix** is a strict improvement over Phase 1's first-match-wins; all 12 prior detection tests continue to pass because none of them used overlapping-strike scenarios. Two new tests cover the disambiguation cases.
- **`handle_spread` lives next to `handle_stage1`/`handle_stage2`** by convention (all in `wheel_strategy.py`). If reviewers prefer splitting spread logic into `wheel_spreads.py`, that's a future cleanup plan, not in scope here.
- **State deletion** on close is intentional — see spec for rationale. Don't preserve `cycle_history` for spreads; JSONL captures the close record.
- **No `min_account_floor`** — that's tied to live enablement, not management itself. Future plan.
- **Live mode unchanged** — `spread_management: False` for live. The flag is wired up so a future plan can flip it without re-architecting.

## Out-of-scope deferrals (for the implementer's awareness)

If any subagent gets ambitious during a task and starts implementing one of these, STOP and report DONE_WITH_CONCERNS. The plan is scoped intentionally:

- Auto-roll: no — Tim opted out
- `min_account_floor` guardrail: no — separate plan tied to live enablement
- Daily summary spread section: no — separate visibility plan
- Dashboard order form: no — separate plan
- Live-mode enablement: no — separate plan after manual paper validation
- Conservative/aggressive enablement: no — those accounts aren't trading spreads
