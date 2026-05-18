# SM Auto-Spread Pending-Fill Loop Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the SM auto-spread engine from infinitely re-opening the same spread every 10-minute cycle by giving the spread lifecycle a real "opening order pending fill" state, making the opening limit actually marketable, and preventing duplicate working orders at the broker.

**Architecture:** Mirror the single-leg wheel's proven `_resolve_pending_contract` pattern for spreads. A bot-opened spread now records its opening order id; `handle_spread` resolves that order's status (pending / filled / stale / gone) **before** the position-based orphan check, so an unfilled order is no longer misread as "closed externally." The opening `mleg` order is priced at a marketable limit (short bid − long ask, capped at the mid) instead of demanding the full decision-time mid with zero slippage. Adopted/hand-opened spreads (manual mode) carry `open_order_id=None` and fall through every new branch unchanged — the four non-SM modes are byte-inert.

**Tech Stack:** Python 3, pytest, existing `wheel_strategy.py` Alpaca REST helpers (`get_order`, `cancel_order`, `api_post`), all Alpaca/yfinance mocked in tests.

---

## Root-cause context (why this plan exists)

Observed 2026-05-18 (day 1 of SM auto-trade live on paper), `#sm2000-trades`: SOFI $14/$13 put credit spread opened at 10:27, "fully closed externally" + reopened at 10:37, again at 10:46/10:47. Alpaca Orders showed three 2-leg orders all `status: new, filled_qty: 0`.

The loop, code-verified:

1. `_auto_open_spread` places an `mleg` limit at `-net_credit` (zero slippage buffer) and seeds `spread_active` state — **without recording the order id**.
2. The limit never fills (decision-time mid on a thin $1-wide deep-OTM chain).
3. Next cycle: `_discover_wheel_state` Phase 2 ([wheel_strategy.py:1866](../../../wheel_strategy.py)) keeps the symbol unconditionally because `stage == "spread_active"`.
4. `handle_spread` ([wheel_strategy.py:561](../../../wheel_strategy.py)) checks only `get_positions()`; the unfilled order has no positions → `_handle_orphan_leg` → both missing → "fully closed externally" → `del state[ticker]`.
5. Post-loop hook re-runs `_auto_open_spread`; concurrency gate counts `spread_active` entries — just deleted → 0 → re-opens. GOTO 1. Prior order never cancelled (orders stack).

Three defects:
- **Bug A (root cause, architectural):** spread lifecycle has no "pending fill" state; single-leg wheel solves this with `_resolve_pending_contract` ([wheel_strategy.py:1034](../../../wheel_strategy.py)). The spread path has no equivalent and never stores the opening order id.
- **Bug B (parametric):** `_open_spread_mleg` ([wheel_strategy.py:2009](../../../wheel_strategy.py)) submits `limit_price = -abs(net_credit)` — the full mid, zero buffer → essentially never fills on thin chains, so Bug A fires every cycle.
- **Bug C (risk):** the reopen path never cancels the prior unfilled order; the concurrency gate counts in-memory state only, not live broker orders.

Scope chosen by Tim: **A + B + C, full PR with TDD + tests.** Containment: none (paper-only; the deploy breaks the loop).

---

## File Structure

- **Modify `wheel_strategy.py`** (single file, all bot logic lives here by project convention):
  - Add module constant `SPREAD_OPEN_MIN_LIMIT = 0.01` near other spread constants.
  - Add `open_order_id` and `open_limit_credit` keys to `_empty_spread_state()` ([:216](../../../wheel_strategy.py)).
  - Add `_spread_order_age_hours(sym_state)` (parallels `_order_age_hours` [:1017](../../../wheel_strategy.py)).
  - Add `_resolve_pending_spread(sym_state)` (parallels `_resolve_pending_contract` [:1034](../../../wheel_strategy.py)).
  - Wire pending resolution into `handle_spread` ([:558](../../../wheel_strategy.py)) before the orphan check.
  - Bug B: `_open_spread_mleg` ([:1997](../../../wheel_strategy.py)) gains optional `limit_credit`; `_auto_open_spread` stashes long bid/ask and passes a marketable limit; seed block records `open_order_id`/`open_limit_credit`.
  - Bug C: add `_open_spread_orders_for(...)` helper + a pre-place duplicate-order guard in `_auto_open_spread`.
- **Modify `tests/test_auto_spread.py`**: resolver tests, Bug B marketable-limit tests, Bug C guard test, update two legacy `_open_spread_mleg` tests' expectations (they encode the old behavior; the default path is unchanged so they actually stay green — verified in Task 6).
- **Modify `tests/test_spread_management.py`**: `handle_spread` pending-resolution wiring tests + end-to-end no-reopen-loop regression test.
- **Modify `CLAUDE.md`**: document the pending-fill state + marketable limit in the spread section.
- **No dashboard changes.** No `config.py` changes (slippage is in-code; the four non-SM modes stay byte-identical).

---

### Task 1: Spread state carries the opening order id

**Files:**
- Modify: `wheel_strategy.py` — `_empty_spread_state()` (around [:216](../../../wheel_strategy.py))
- Test: `tests/test_auto_spread.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_auto_spread.py`:

```python
def test_empty_spread_state_has_open_order_tracking_fields():
    ss = ws._empty_spread_state()
    assert ss["stage"] == "spread_active"
    assert ss["open_order_id"] is None
    assert ss["open_limit_credit"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_auto_spread.py::test_empty_spread_state_has_open_order_tracking_fields -v`
Expected: FAIL — `KeyError: 'open_order_id'`

- [ ] **Step 3: Add the fields**

In `_empty_spread_state()`'s returned dict, add these two keys immediately after the `"opened_at": None,` line:

```python
        "opened_at": None,
        # Bot-opened spreads only: id of the mleg open order + the credit
        # the marketable limit was placed at. Adopted/hand-opened spreads
        # leave these None so _resolve_pending_spread short-circuits to
        # "gone" and the existing position/orphan path runs unchanged.
        "open_order_id": None,
        "open_limit_credit": None,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_auto_spread.py::test_empty_spread_state_has_open_order_tracking_fields -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "fix(wheel): add open_order_id tracking to spread state shape"
```

---

### Task 2: `_spread_order_age_hours` helper

**Files:**
- Modify: `wheel_strategy.py` — add directly above `_resolve_pending_contract` ([:1034](../../../wheel_strategy.py))
- Test: `tests/test_auto_spread.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_auto_spread.py`:

```python
from datetime import datetime, timezone, timedelta


def test_spread_order_age_hours_parses_opened_at():
    three_h_ago = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat().replace("+00:00", "Z")
    assert abs(ws._spread_order_age_hours({"opened_at": three_h_ago}) - 3.0) < 0.05


def test_spread_order_age_hours_missing_or_bad_returns_zero():
    assert ws._spread_order_age_hours({}) == 0.0
    assert ws._spread_order_age_hours({"opened_at": None}) == 0.0
    assert ws._spread_order_age_hours({"opened_at": "not-a-date"}) == 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_auto_spread.py::test_spread_order_age_hours_parses_opened_at tests/test_auto_spread.py::test_spread_order_age_hours_missing_or_bad_returns_zero -v`
Expected: FAIL — `AttributeError: module 'wheel_strategy' has no attribute '_spread_order_age_hours'`

- [ ] **Step 3: Implement the helper**

Insert immediately above `def _resolve_pending_contract(sym_state):` in `wheel_strategy.py`:

```python
def _spread_order_age_hours(sym_state) -> float:
    """Hours since a bot-opened spread's opening order was placed.

    Reads `opened_at` (ISO8601, '...Z'). Returns 0.0 on missing or
    unparseable input — defensive: a parse error must never spuriously
    trigger the stale-cancel path. Parallels _order_age_hours.
    """
    opened_at = sym_state.get("opened_at")
    if not opened_at:
        return 0.0
    try:
        dt = datetime.fromisoformat(opened_at.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600
    except (ValueError, TypeError):
        return 0.0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_auto_spread.py::test_spread_order_age_hours_parses_opened_at tests/test_auto_spread.py::test_spread_order_age_hours_missing_or_bad_returns_zero -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "fix(wheel): add _spread_order_age_hours for spread stale detection"
```

---

### Task 3: `_resolve_pending_spread` resolver

**Files:**
- Modify: `wheel_strategy.py` — add directly below `_resolve_pending_contract` (ends [:1064](../../../wheel_strategy.py))
- Test: `tests/test_auto_spread.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_auto_spread.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_auto_spread.py -k resolve_pending_spread -v`
Expected: FAIL — `AttributeError: ... '_resolve_pending_spread'`

- [ ] **Step 3: Implement the resolver**

Insert immediately below the end of `_resolve_pending_contract` (after its `return "gone"` line, before `def get_option_last_price`):

```python
def _resolve_pending_spread(sym_state):
    """Disambiguate a bot-opened spread whose opening mleg order may not
    have filled yet. Spread-side parallel of _resolve_pending_contract.

    Only meaningful when sym_state['open_order_id'] is set (bot-opened
    spreads). Adopted/hand-opened spreads leave it None → returns "gone"
    and the caller falls through to the existing position/orphan path
    unchanged.

    Returns:
      "pending" — opening order still working; skip this cycle.
      "stale"   — working > STALE_AFTER_HOURS; caller cancels + clears.
      "filled"  — opening order filled; legs are now/imminently positions.
      "gone"    — order canceled/rejected/expired/404/no id.
    """
    order_id = sym_state.get("open_order_id")
    if not order_id:
        return "gone"
    order = get_order(order_id)
    if order is None:
        return "gone"
    status = order.get("status", "")
    if status in ("new", "accepted", "pending_new",
                  "partially_filled", "accepted_for_bidding"):
        if _spread_order_age_hours(sym_state) > STALE_AFTER_HOURS:
            return "stale"
        return "pending"
    if status == "filled":
        return "filled"
    return "gone"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_auto_spread.py -k resolve_pending_spread -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "fix(wheel): add _resolve_pending_spread (mirrors single-leg pending resolver)"
```

---

### Task 4: Wire pending resolution into `handle_spread`

**Files:**
- Modify: `wheel_strategy.py` — `handle_spread`, between `sym_state = state[ticker]` and `positions = get_positions()` ([:558–:568](../../../wheel_strategy.py))
- Test: `tests/test_spread_management.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_spread_management.py` (top of file already does `import wheel_strategy as ws`; if not, add it):

```python
import wheel_strategy as ws


def _active_spread_state(open_order_id="ord-1"):
    ss = ws._empty_spread_state()
    ss["spread_type"] = "put_credit"
    ss["short_leg"] = {"occ": "SOFI260605P00014000", "strike": 14.0,
                       "entry_premium": 0.30, "qty": 1}
    ss["long_leg"] = {"occ": "SOFI260605P00013000", "strike": 13.0,
                      "entry_premium": 0.20, "qty": 1}
    ss["expiration"] = "2026-06-05"
    ss["net_credit"] = 0.10
    ss["max_loss"] = 0.90
    ss["width"] = 1.0
    ss["opened_at"] = "2026-05-18T14:27:00Z"
    ss["open_order_id"] = open_order_id
    return ss


def test_handle_spread_pending_order_skips_no_close_no_delete(monkeypatch):
    """The exact loop bug: open order unfilled, no leg positions. Must NOT
    fire the orphan/'closed externally' path and must NOT delete state."""
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "new"})
    monkeypatch.setattr(ws, "STALE_AFTER_HOURS", 48.0)
    called = {"positions": 0, "orphan": 0}
    monkeypatch.setattr(ws, "get_positions",
                        lambda: called.__setitem__("positions", called["positions"] + 1) or [])
    monkeypatch.setattr(ws, "_handle_orphan_leg",
                        lambda *a, **k: called.__setitem__("orphan", called["orphan"] + 1))
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert "SOFI" in state, "must not delete state while open order pending"
    assert called["orphan"] == 0, "must not reach orphan/closed-externally path"
    assert called["positions"] == 0, "must short-circuit before position fetch"


def test_handle_spread_filled_clears_marker_and_returns(monkeypatch):
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "filled"})
    monkeypatch.setattr(ws, "get_positions", lambda: [])
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert state["SOFI"]["open_order_id"] is None
    assert state["SOFI"]["stage"] == "spread_active"


def test_handle_spread_stale_cancels_and_clears(monkeypatch):
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "new"})
    monkeypatch.setattr(ws, "STALE_AFTER_HOURS", 0.0)  # any age is stale
    cancelled = []
    monkeypatch.setattr(ws, "cancel_order",
                        lambda oid: cancelled.append(oid) or True)
    monkeypatch.setattr(ws, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert cancelled == ["ord-1"]
    assert "SOFI" not in state, "stale open order → cancel + clear state"


def test_handle_spread_stale_cancel_fails_keeps_state(monkeypatch):
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "new"})
    monkeypatch.setattr(ws, "STALE_AFTER_HOURS", 0.0)
    monkeypatch.setattr(ws, "cancel_order", lambda oid: False)
    monkeypatch.setattr(ws, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert "SOFI" in state, "failed cancel must leave state for retry"


def test_handle_spread_adopted_no_order_id_uses_existing_path(monkeypatch):
    """Manual-mode hand-opened spread: open_order_id None → resolver not
    consulted, existing orphan path runs (isolation guarantee)."""
    ss = _active_spread_state(open_order_id=None)
    state = {"SOFI": ss}
    orphan_called = []
    monkeypatch.setattr(ws, "get_positions", lambda: [])
    monkeypatch.setattr(ws, "_handle_orphan_leg",
                        lambda *a, **k: orphan_called.append(True))
    got_order = []
    monkeypatch.setattr(ws, "get_order", lambda oid: got_order.append(oid))
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert got_order == [], "resolver must not be consulted when no open_order_id"
    assert orphan_called == [True], "existing orphan path must run unchanged"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_spread_management.py -k "handle_spread_pending or handle_spread_filled or handle_spread_stale or handle_spread_adopted" -v`
Expected: FAIL — pending/filled/stale tests fail (state deleted / orphan reached) because the resolution block does not exist yet.

- [ ] **Step 3: Insert the pending-resolution block**

In `handle_spread`, the current head is:

```python
    sym_state = state[ticker]
    positions = get_positions()

    # 1. Orphan detection — before any snapshot fetch
```

Replace exactly that (the `sym_state = state[ticker]` line through the blank line before `positions = get_positions()`) with:

```python
    sym_state = state[ticker]

    # Pending-fill resolution MUST precede the position-based orphan check.
    # A bot-opened spread whose mleg order has not filled yet has NO leg
    # positions; without this guard the orphan check below misreads
    # "not filled yet" as "closed externally", deletes state, and the
    # opener immediately re-opens (the infinite 10-min loop / stacked
    # orders observed on sm2000 2026-05-18). Adopted/hand-opened spreads
    # carry open_order_id=None and fall straight through unchanged.
    if sym_state.get("open_order_id"):
        pstatus = _resolve_pending_spread(sym_state)
        if pstatus == "pending":
            log(f"[{ticker}] spread open order {sym_state['open_order_id']} "
                f"pending fill — skipping cycle")
            sym_state["last_action"] = (
                f"Awaiting fill on spread open order {sym_state['open_order_id']}.")
            return
        if pstatus == "filled":
            log(f"[{ticker}] spread open order filled — clearing pending "
                f"marker, managing from next cycle")
            sym_state["open_order_id"] = None
            sym_state["last_action"] = "Spread open order filled — now managing."
            return
        if pstatus == "stale":
            order_id = sym_state["open_order_id"]
            age_h = _spread_order_age_hours(sym_state)
            log(f"[{ticker}] spread open order {order_id} stale at "
                f"{age_h:.1f}h — cancelling")
            if cancel_order(order_id):
                send_embed(
                    ACTIONS_CH,
                    f"Wheel: spread {ticker} open order stale at {age_h:.1f}h — cancelled",
                    color=Color.YELLOW,
                    description=(
                        f"Opening limit `{order_id}` for {ticker} did not fill "
                        f"within {STALE_AFTER_HOURS}h. Cancelled and cleared "
                        f"state so the opener can re-evaluate at a fresh mid."
                    ),
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH, also_to_actions=False,
                )
                log_event(LOG_STREAM, "wheel_strategy.py",
                          "spread_open_stale_cancelled", result="success",
                          symbol=ticker,
                          details={"order_id": order_id,
                                   "age_hours": round(age_h, 1)})
                del state[ticker]
            else:
                log(f"[{ticker}] cancel of stale spread open order "
                    f"{order_id} returned False — retry next cycle")
                sym_state["last_action"] = (
                    "Cancel of stale spread open order FAILED; will retry.")
                log_event(LOG_STREAM, "wheel_strategy.py",
                          "spread_open_stale_cancel_failed", result="failure",
                          symbol=ticker, details={"order_id": order_id})
            return
        # pstatus == "gone": order canceled/rejected/expired/404. Clear the
        # marker and fall through to the existing orphan handler, which
        # closes any partially-filled survivor leg or clears state if
        # nothing filled. Reusing the tested path keeps the change minimal.
        sym_state["open_order_id"] = None

    positions = get_positions()

    # 1. Orphan detection — before any snapshot fetch
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_spread_management.py -k "handle_spread_pending or handle_spread_filled or handle_spread_stale or handle_spread_adopted" -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "fix(wheel): resolve spread open-order status before orphan check (stops reopen loop)"
```

---

### Task 5: Record `open_order_id` when the opener seeds state

**Files:**
- Modify: `wheel_strategy.py` — `_auto_open_spread` seed block ([:2222–:2260](../../../wheel_strategy.py))
- Test: `tests/test_auto_spread.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_auto_spread.py` (reuses `_wire_sm`, `_contract` already in the file):

```python
def test_auto_open_records_open_order_id_in_state(monkeypatch):
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
    # _wire_sm patches _open_spread_mleg to return {"id": "ord-1"}
    state = {"_meta": {}}
    ws._auto_open_spread(state, {"options_buying_power": "2000"}, cfg)

    assert state["CHEAP"]["open_order_id"] == "ord-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_auto_spread.py::test_auto_open_records_open_order_id_in_state -v`
Expected: FAIL — `assert None == 'ord-1'` (seed block doesn't set it yet)

- [ ] **Step 3: Set `open_order_id` in the seed block**

In `_auto_open_spread`, the order id is currently extracted at `order_id = order.get("id", "?") ...` **after** the state seed. Move that extraction to just after the `_open_spread_mleg` call and record it in state. Specifically, immediately after this existing block:

```python
        try:
            order = _open_spread_mleg(short_occ, chosen["long_occ"],
                                      1, net_credit)
        except Exception as e:
            ...
            return  # one attempt per cycle either way
```

add:

```python
        order_id = order.get("id", "?") if isinstance(order, dict) else "?"
```

Then in the `ss = _empty_spread_state()` seed block, add this line right after `ss["opened_at"]  = datetime.utcnow().isoformat() + "Z"`:

```python
        ss["open_order_id"] = order_id if order_id != "?" else None
```

Finally, delete the now-duplicate later line `order_id = order.get("id", "?") if isinstance(order, dict) else "?"` that precedes the `send_embed(TRADES_CH, ...)` call (the variable is already set above; the embed and `log_event` continue to use `order_id` unchanged).

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_auto_spread.py::test_auto_open_records_open_order_id_in_state -v`
Expected: PASS

- [ ] **Step 5: Run the full auto-spread suite (no regressions)**

Run: `python -m pytest tests/test_auto_spread.py -v`
Expected: PASS (all existing + new). The happy-path test still asserts state shape; `open_order_id` is additive.

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "fix(wheel): record open_order_id when opener seeds spread state"
```

---

### Task 6: Bug B — marketable opening limit (short bid − long ask, capped at mid)

**Files:**
- Modify: `wheel_strategy.py` — module constant; `_open_spread_mleg` ([:1997](../../../wheel_strategy.py)); `_auto_open_spread` long-leg `chosen` dict ([:2175–:2181](../../../wheel_strategy.py)) and placement ([:2222–:2225](../../../wheel_strategy.py))
- Test: `tests/test_auto_spread.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_auto_spread.py`:

```python
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
    """End-to-end: short mid 0.60 / long mid 0.35 → recorded net_credit
    0.25, but the order is placed at short_bid - long_ask = 0.55 - 0.40
    = 0.15 (marketable), capped at the 0.25 mid."""
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
    ws.AUTO_OPEN_SPREADS = True
    import config
    cfg = dict(config.get_mode("sm1000"))
    cfg["max_underlying_price"] = None
    monkeypatch.setattr(ws, "get_account",
                        lambda: {"equity": "1000", "options_buying_power": "2000"})
    import screener_core, earnings as earnings_mod
    monkeypatch.setattr(screener_core, "build_universe", lambda u, w: ["CHEAP"])
    monkeypatch.setattr(screener_core, "score_candidate",
                        lambda s, bp, **k: {"score": 9.0, "price": 20.0})
    monkeypatch.setattr(earnings_mod, "next_earnings_within",
                        lambda s, d: False)

    def fake_find(u, t, ts, dmin, dmax):
        cands = {k[1]: v for k, v in contracts.items() if k[0] == u}
        return cands[min(cands, key=lambda s: abs(s - ts))]
    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: quotes.get(occ))
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

    assert round(captured["net_credit"], 2) == 0.25      # recorded = mid
    assert round(captured["limit_credit"], 2) == 0.15    # 0.55 - 0.40
    assert round(state["CHEAP"]["net_credit"], 2) == 0.25
    assert round(state["CHEAP"]["open_limit_credit"], 2) == 0.15
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_auto_spread.py -k "marketable or limit_credit or default_limit_unchanged" -v`
Expected: FAIL — `_open_spread_mleg` has no `limit_credit` param (`TypeError`); `open_limit_credit` not populated.

- [ ] **Step 3: Add the constant and update `_open_spread_mleg`**

Near the top of `wheel_strategy.py`, beside the other spread constants (search for `SPREAD_EARLY_CLOSE_PCT` assignment and add adjacent to that group, module scope):

```python
SPREAD_OPEN_MIN_LIMIT = 0.01  # floor for the opening mleg limit credit so a
                              # thin/negative natural bid still posts a 1-cent
                              # credit order (stale path cancels it if it never
                              # fills) rather than flipping to a debit.
```

Replace `_open_spread_mleg` in full with:

```python
def _open_spread_mleg(short_occ: str, long_occ: str, qty: int,
                      net_credit: float, limit_credit: float = None):
    """Submit an Alpaca multi-leg sell-to-open put credit spread.

    `net_credit` is the decision-time mid (recorded in state, used for
    P&L). `limit_credit`, when provided, is the *marketable* credit the
    order is actually placed at (short bid − long ask, capped at the
    mid) so the order fills instead of resting at an untradeable mid.
    When None, falls back to the mid (legacy behavior — keeps direct
    callers and the four non-SM modes byte-identical).
    """
    if limit_credit is None:
        eff_credit = abs(net_credit)
    else:
        eff_credit = max(round(limit_credit, 2), SPREAD_OPEN_MIN_LIMIT)
    return api_post("/orders", {
        "order_class":   "mleg",
        "qty":           str(qty),
        "type":          "limit",
        "limit_price":   f"{round(-eff_credit, 2):.2f}",  # 2dp string (Alpaca credit convention); str(round(-0.1,2)) would emit "-0.1"
        "time_in_force": "day",
        "legs": [
            {"symbol": short_occ, "side": "sell", "ratio_qty": "1", "position_intent": "sell_to_open"},
            {"symbol": long_occ,  "side": "buy",  "ratio_qty": "1", "position_intent": "buy_to_open"},
        ],
    })
```

- [ ] **Step 4: Stash long bid/ask and pass the marketable limit**

In `_auto_open_spread`, the long-leg `chosen` dict is built as:

```python
            chosen = {
                "long_occ":    long_contract["symbol"],
                "long_strike": long_strike,
                "long_mid":    long_mid,
                "width":       width,
            }
```

Add the raw long quote sides:

```python
            chosen = {
                "long_occ":    long_contract["symbol"],
                "long_strike": long_strike,
                "long_mid":    long_mid,
                "long_bid":    long_q["bid"],
                "long_ask":    long_q["ask"],
                "width":       width,
            }
```

At the placement site, currently:

```python
        max_loss   = round(width - net_credit, 4)
        try:
            order = _open_spread_mleg(short_occ, chosen["long_occ"],
                                      1, net_credit)
```

replace with:

```python
        max_loss   = round(width - net_credit, 4)
        # Marketable opening limit: sell the short at its bid, buy the long
        # at its ask (the price the spread can actually transact at), but
        # never demand MORE credit than the mid, and floor at one cent.
        marketable_credit = max(
            round(short_q["bid"] - chosen["long_ask"], 2),
            SPREAD_OPEN_MIN_LIMIT,
        )
        marketable_credit = min(marketable_credit, net_credit)
        try:
            order = _open_spread_mleg(short_occ, chosen["long_occ"],
                                      1, net_credit,
                                      limit_credit=marketable_credit)
```

Then in the `ss = _empty_spread_state()` seed block, add right after the `ss["open_order_id"] = ...` line added in Task 5:

```python
        ss["open_limit_credit"] = marketable_credit
```

**Also update the shared `_wire_sm` test helper** in `tests/test_auto_spread.py`: its mocked `_open_spread_mleg` lambda must accept the new kwarg, or the ~11 existing `_wire_sm`-based tests `TypeError`. Change `lambda s, l, qty, nc:` to `lambda s, l, q, nc, limit_credit=None:` and add `"limit_credit": limit_credit` to the recorded `opened` dict (purely additive — existing assertions on `short`/`long`/`qty`/`net_credit` are untouched).

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_auto_spread.py -k "marketable or limit_credit or default_limit_unchanged" -v`
Expected: PASS (4 passed)

- [ ] **Step 6: Run the full auto-spread + spread suites**

Run: `python -m pytest tests/test_auto_spread.py tests/test_spread_management.py tests/test_spread_detection.py -v`
Expected: PASS. Note: legacy `test_open_spread_mleg_builds_exact_body` / `test_open_spread_mleg_limit_is_negative_of_credit` still pass — they call `_open_spread_mleg` without `limit_credit`, which preserves the `-abs(net_credit)` output.

- [ ] **Step 7: Commit**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "fix(wheel): place spread opening order at a marketable limit, not the bare mid"
```

---

### Task 7: Bug C — guard against duplicate working orders at the broker

**Files:**
- Modify: `wheel_strategy.py` — add `_working_spread_order_exists` helper near `get_order` ([:752](../../../wheel_strategy.py)); guard in `_auto_open_spread` right before the `_open_spread_mleg` call
- Test: `tests/test_auto_spread.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_auto_spread.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_auto_spread.py -k "working_spread_order or skips_symbol_with_existing" -v`
Expected: FAIL — `_working_spread_order_exists` undefined.

- [ ] **Step 3: Implement the helper**

Insert directly below `get_order` in `wheel_strategy.py`:

```python
def _working_spread_order_exists(short_occ: str, long_occ: str) -> bool:
    """True if Alpaca currently has a non-terminal order touching either
    leg. Belt-and-suspenders against the state-loss reopen window: even
    if seeded state is lost before save_state, we won't stack a second
    mleg at the broker. A lookup failure returns False (defensive — a
    transient API error must not freeze the opener forever; the in-state
    concurrency gate is the primary guard).
    """
    try:
        orders = api_get("/orders", params={"status": "open", "nested": "true"})
    except Exception as e:
        log(f"_working_spread_order_exists lookup failed: {type(e).__name__}: {e}")
        return False
    terminal = {"filled", "canceled", "cancelled", "expired",
                "rejected", "done_for_day", "replaced"}
    targets = {short_occ, long_occ}
    for o in orders or []:
        if o.get("status") in terminal:
            continue
        legs = o.get("legs") or []
        for leg in legs:
            if leg.get("symbol") in targets:
                return True
        if o.get("symbol") in targets:
            return True
    return False
```

- [ ] **Step 4: Add the guard in `_auto_open_spread`**

Immediately before the `max_loss = round(width - net_credit, 4)` line (just before the marketable-credit computation added in Task 6), insert:

```python
        if _working_spread_order_exists(short_occ, chosen["long_occ"]):
            log(f"[auto-spread] {sym} already has a working order on a "
                f"spread leg — skipping to avoid a duplicate")
            log_event(LOG_STREAM, "wheel_strategy.py",
                      "auto_spread_skip", result="skipped", symbol=sym,
                      notes="working_order_exists",
                      details={"short_occ": short_occ,
                               "long_occ": chosen["long_occ"]})
            continue
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_auto_spread.py -k "working_spread_order or skips_symbol_with_existing" -v`
Expected: PASS (4 passed)

- [ ] **Step 6: Commit**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "fix(wheel): skip auto-open when a working order already exists on the legs"
```

---

### Task 8: Full regression + isolation verification

**Files:** none (verification only)

- [ ] **Step 1: Full bot test suite**

Run: `python -m pytest tests/ -q`
Expected: PASS. Baseline was **380 pytest**; this plan adds ~25 tests and changes none destructively → expect ~405 passed, 0 failed.

- [ ] **Step 2: Mode-isolation explicit check**

Run: `python -m pytest tests/test_modes_sm.py tests/test_manual_mode.py -v`
Expected: PASS. Confirms `AUTO_OPEN_SPREADS` still off for cons/agg/manual/live and manual adoption unaffected (`open_order_id=None` path).

- [ ] **Step 3: Confirm dashboard untouched**

Run: `git diff --name-only main...HEAD`
Expected: only `wheel_strategy.py`, `tests/test_auto_spread.py`, `tests/test_spread_management.py`, `docs/superpowers/plans/2026-05-18-sm-spread-pending-fill-fix.md` (and `CLAUDE.md` after Task 9). No `dashboard/` paths.

- [ ] **Step 4: Commit (no-op if clean)** — nothing to commit; this is a gate.

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` — the "SM auto-spread engine" subsection

- [ ] **Step 1: Update CLAUDE.md**

In `CLAUDE.md`, find the SM auto-spread "Spread construction:" bullet that reads:

```
**Spread construction:** short put ≈ 10% OTM, narrowest available width that satisfies the risk cap, 14–28 DTE, net credit = short_mid − long_mid. Placed via new `_open_spread_mleg()` (Alpaca `order_class: mleg`, STO short / BTO long, limit = −net_credit, mirroring the close primitive).
```

Replace the final sentence so it reads:

```
**Spread construction:** short put ≈ 10% OTM, narrowest available width that satisfies the risk cap, 14–28 DTE, net credit = short_mid − long_mid. Placed via `_open_spread_mleg()` (Alpaca `order_class: mleg`, STO short / BTO long) at a **marketable** limit (`short_bid − long_ask`, capped at the mid, floored at $0.01) — NOT the bare mid, which never filled on thin chains. The recorded `net_credit` stays the mid (P&L is mid-based, approximate, as documented). The seeded `spread_active` state records `open_order_id`; `handle_spread` resolves that order via `_resolve_pending_spread` (pending / filled / stale / gone) **before** the position-based orphan check, so an unfilled open order is never misread as "closed externally" (the 2026-05-18 sm2000 reopen-loop fix). A stale unfilled open order (> `stale_after_hours`) is cancelled and state cleared; `_working_spread_order_exists` blocks a duplicate mleg if state is lost mid-window.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document spread pending-fill state + marketable opening limit"
```

---

### Task 10: Open the PR

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin claude/dreamy-varahamihira-90ffdb
gh pr create --title "Fix SM auto-spread infinite reopen loop (pending-fill state + marketable limit)" --body "$(cat <<'EOF'
## Summary
- **Bug A (root cause):** spread lifecycle had no "opening order pending fill" state. An unfilled mleg order has no leg positions, so `handle_spread`'s position-based orphan check misread it as "closed externally", deleted state, and the opener immediately re-opened — an infinite 10-min loop with stacked orders (observed on sm2000 2026-05-18). Fixed by recording `open_order_id` and resolving it via `_resolve_pending_spread` (mirrors the single-leg `_resolve_pending_contract`) before the orphan check.
- **Bug B:** opening limit was `-abs(net_credit)` (the bare decision-time mid, zero buffer) → never filled on thin deep-OTM chains. Now placed at a marketable limit (`short_bid − long_ask`, capped at the mid, $0.01 floor). Recorded `net_credit` unchanged (still the mid).
- **Bug C:** reopen never cancelled the prior order. Stale unfilled opens are now cancelled + cleared; `_working_spread_order_exists` blocks a duplicate mleg if state is lost mid-window.
- Four non-SM modes (cons/agg/manual/live) and manual adopted/hand-opened spreads are byte-inert: every new branch is gated on `open_order_id`, which only the SM opener sets.

## Test plan
- [ ] `python -m pytest tests/ -q` green (~405 passed, +~25)
- [ ] `tests/test_modes_sm.py` + `tests/test_manual_mode.py` confirm mode isolation
- [ ] `git diff --name-only main...HEAD` shows no `dashboard/` changes
- [ ] Post-deploy: watch `#sm2000-trades` / `#sm1000-trades` / `#sm500-trades` next market open — expect ONE open then a "pending fill" heartbeat (no "fully closed externally" reopen spam), and the order actually fills at the marketable limit

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Bug A (pending-fill state) → Tasks 1, 2, 3, 4, 5 ✓
- Bug B (marketable limit) → Task 6 ✓
- Bug C (duplicate-order guard + stale cancel) → Task 4 (stale cancel) + Task 7 (working-order guard) ✓
- Isolation of cons/agg/manual/live + manual adoption → Task 4 adopted-path test, Task 6 default-limit test, Task 8 ✓
- Full PR + TDD + tests → every task is test-first; Task 10 PR ✓
- Docs per project convention → Task 9 (CLAUDE.md) + this plan doc ✓

**2. Placeholder scan:** No TBD/“handle edge cases”/“similar to Task N”. Every code step has complete code; every test step has full assertions; every run step has an exact command + expected outcome.

**3. Type consistency:** `_resolve_pending_spread` returns the literal set `{"pending","filled","stale","gone"}` — `handle_spread` branches on exactly those four. `_spread_order_age_hours`/`open_order_id`/`open_limit_credit`/`SPREAD_OPEN_MIN_LIMIT`/`_working_spread_order_exists` are defined once and used with consistent names/signatures. `_open_spread_mleg(short_occ, long_occ, qty, net_credit, limit_credit=None)` matches the Task 6 `_wire_sm` lambda signature `(s, l, q, nc, limit_credit=None)`. Status tuple in `_resolve_pending_spread` mirrors `_resolve_pending_contract` exactly.

No gaps found.
