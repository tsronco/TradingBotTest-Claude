# Stale-Order Cancel-and-Replace v1

**Date:** 2026-05-01
**Status:** Approved (pending user review of this spec)
**Mode:** Both (conservative + aggressive)

## Problem

The wheel quotes sell-to-open orders at the **mid of the bid/ask spread**. On illiquid options (wide spreads), this limit price often sits above the bid and never fills. As of 2026-05-01 there were four such orders sitting on Alpaca:

| Account | Order | Age |
|---|---|---|
| Conservative | RIVN call @ $0.81 | 2.5 hr |
| Conservative | XOM put @ $0.44 | 1.5 hr |
| Conservative | SOFI put @ $0.17 | 1 hr |
| Aggressive | BAC put @ $0.08 | 1.5 hr |

Stale orders tie up buying power and prevent the wheel from deploying capital elsewhere. Conservative is especially affected — the symbols at the end of the priority list (e.g., INTC) get squeezed out by stale orders ahead of them.

## Goal

Cancel any wheel sell-to-open order that has been pending for more than `STALE_AFTER_HOURS` (default: 4), free up the buying power, and immediately attempt a fresh order at the **current** mid price.

The fresh order may still be illiquid and stay pending another 4 hours — and that's fine. We're explicitly choosing **simplicity + observability** for v1: cancel and refresh, watch what happens, iterate.

## Non-Goals (deferred)

- **Reprice toward the bid** — never accept a worse premium than mid.
- **Reprice cap** — no max-cancellations-per-contract counter yet. If the loop thrashes, we'll add a cap in v2.
- **Per-symbol cooldown** — no "skip this symbol for the rest of the day" logic yet.
- **Buy-to-close orders** — these are 50%-profit closes; they have different semantics and aren't usually stale. Out of scope for v1.
- **Per-symbol threshold tuning** — `STALE_AFTER_HOURS` is a single per-mode value; no per-symbol overrides.

## Design

### Architecture

A small extension to the existing wheel state machine in `wheel_strategy.py`. No new processes, no new workflows, no new state files.

### Components

**1. New helper: `cancel_order(order_id)` in `wheel_strategy.py`**

Thin wrapper around Alpaca's `DELETE /v2/orders/{id}`. Returns `True` on success, `False` on failure.

Idempotent: if the order is already gone (404) or already filled (422), treat as success — caller's intent ("this order should not be open anymore") has been satisfied either way.

**2. New return value: `"stale"` from `_resolve_pending_contract`**

Currently returns `"pending"` / `"just_filled"` / `"gone"`.

Add `"stale"` when:
- Status would otherwise be `"pending"` (i.e., order is `new`/`accepted`/`pending_new`/`partially_filled`/`accepted_for_bidding`)
- AND `now - contract_entry_date > STALE_AFTER_HOURS`

Order of evaluation matters: check `"stale"` BEFORE returning `"pending"`. Don't override `"just_filled"` or `"gone"` — those represent terminal states that need their existing handling.

**3. New handling in `handle_stage1` and `handle_stage2`**

When `_resolve_pending_contract` returns `"stale"`:

```
1. Call cancel_order(sym_state["contract_order_id"])
2. If cancel succeeds:
   - Clear sym_state["current_contract"] = None
   - Clear sym_state["contract_order_id"] = None
   - Clear sym_state["contract_entry_date"] = None
   - Log "Wheel: {SYM} order stale at {age:.1f}h — cancelled, retrying fresh"
   - Send to ACTIONS_CH (muted, not errors)
   - Fall through to existing "no current_contract" branch
     → calls _sell_new_put or _sell_new_call with current quote
3. If cancel fails:
   - Log error
   - Send to ERRORS_CH
   - Leave state untouched
   - Skip remainder of cycle for this symbol
   - Will retry next cycle
```

**4. New config field: `stale_after_hours` per mode in `config.MODES`**

```python
MODES = {
    "conservative": {
        ...
        "stale_after_hours": 4,
    },
    "aggressive": {
        ...
        "stale_after_hours": 4,
    },
}
```

`apply_mode()` reads this into a module-level `STALE_AFTER_HOURS` in `wheel_strategy.py`, matching the pattern used for `PUT_STRIKE_PCT`, `EARLY_CLOSE_PCT`, etc.

### Data flow

```
Cycle starts
    ↓
for symbol in SYMBOLS:
    ↓
  has current_contract?
    ↓ yes
  get_option_position()
    ↓ None (no fill)
  _resolve_pending_contract()
    ↓
    ├─ "pending"     → log "still pending", continue (existing)
    ├─ "just_filled" → log fill, continue (existing)
    ├─ "gone"        → handle assignment/expiration (existing)
    └─ "stale" (NEW) → cancel + clear state + ACTIONS_CH log
                       ↓
                       fall through to "no contract" branch
                       ↓
                       _sell_new_put / _sell_new_call (existing)
                       ↓
                       new order placed at fresh mid
```

The fresh sell happens in the **same cycle** as the cancel. No waiting until the next 10-min fire. BP is now free; we want to deploy it.

### Error handling

| Scenario | Handling |
|---|---|
| Cancel API returns 5xx / network error | Log to ERRORS_CH, leave state untouched, retry next cycle. **Do not** place a new order while old one might still be live. |
| Cancel succeeds but refill fails | Standard per-symbol error handling already in place; state has cleared the contract field, so next cycle starts fresh. |
| Order filled in the race between staleness check and cancel POST | Alpaca returns 422 ("cannot cancel filled order"). Treat as success — `get_option_position` next cycle picks up the position normally. |
| Order already cancelled externally (404) | Treat as success. Clear state and place fresh order. |

### Testing

Add to `tests/test_wheel_assignment.py`:

| Test | What it verifies |
|---|---|
| `test_stale_order_cancelled_and_replaced` | Pending order > 4hr → `cancel_order` called → new sell placed in same cycle |
| `test_pending_order_under_threshold_stays_pending` | Order pending 3hr → no cancel attempted → normal "still pending" path |
| `test_stale_order_cancel_failure_does_not_replace` | `cancel_order` returns False → no new sell placed → state untouched |
| `test_stale_order_filled_during_race_treated_as_success` | Cancel returns 422 → state cleared → next cycle handles via position lookup |
| `test_stale_threshold_configurable_per_mode` | `STALE_AFTER_HOURS` reads from `config.MODES[mode]["stale_after_hours"]` |
| `test_stale_logic_applies_to_stage2_calls` | Same logic on Stage 2 covered call orders, not just Stage 1 puts |

All tests use the existing `alpaca_account_state` fixture and mock `cancel_order` / `place_sell_to_open`.

### Observability

**JSONL log streams** (new event names):

- `stale_order_cancelled` — every successful cancel of a stale order
- `stale_order_cancel_failed` — every failed cancel attempt (paired with errors channel ping)
- `stale_order_replaced` — when the replacement sell goes through

Each event includes: `symbol`, `contract`, `age_hours`, `original_limit`, `new_limit` (for replacements).

**Discord routing:**

- Successful stale-cancel-and-replace → ACTIONS_CH only (muted firehose)
- Cancel API failure → ERRORS_CH (push notification)

This keeps the success case quiet — it's expected behavior, not an alert. Only the genuinely-broken cases (Alpaca API down, etc.) ping the phone.

### Code locations

| File | Change |
|---|---|
| `config.py` | Add `stale_after_hours: 4` to both `MODES` entries |
| `wheel_strategy.py` | Add `STALE_AFTER_HOURS` module global; `apply_mode()` reads it from config |
| `wheel_strategy.py` | Add `cancel_order(order_id)` helper near `place_sell_to_open` |
| `wheel_strategy.py` | Modify `_resolve_pending_contract` to return `"stale"` when applicable |
| `wheel_strategy.py` | Modify `handle_stage1` and `handle_stage2` to handle `"stale"` status |
| `tests/test_wheel_assignment.py` | Add 6 new tests per matrix above |

### Estimated change size

~40 lines of production code, ~80 lines of tests. Single commit, single PR. Should land same day as the implementation plan.

## Success criteria

After deployment:

1. **No more orders aging past 4 hours** in either account.
2. **Conservative INTC** (and other end-of-priority symbols) get a chance to attempt orders when earlier symbols' stale orders are cancelled.
3. **Discord errors channel stays quiet** — stale-cancel events only go to actions firehose.
4. **No spurious behavior** — the loop doesn't thrash (cancel/refill/cancel/refill on the same contract repeatedly within minutes). If we observe thrashing in practice, that's the trigger to add a v2 reprice cap.

## Future (v2 candidates, not in scope)

- **Reprice cap**: max N cancellations per contract per trading day; after N, stop trying that symbol until next session.
- **Per-symbol staleness tuning**: some symbols (RIVN) might warrant longer thresholds.
- **Apply to buy-to-close orders**: 50%-profit closes that drift; needs different semantics since cancellation here means "stop trying to lock in profit," not "free up BP."
- **Smart limit pricing**: instead of mid-of-spread on the refill, use mid + 25% toward the bid for the second attempt — slight chase to improve fill rate while still capping concession.
