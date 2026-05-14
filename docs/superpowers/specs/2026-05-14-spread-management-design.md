# Spread Management — Phase 2 Design

> **Phase 2 of the spread support track.** Phase 1 (foundation: detection + state schema + long-options skip guard) shipped 2026-05-14 in [PR #9](https://github.com/tsronco/TradingBotTest-Claude/pull/9). This document specifies the next slice: `handle_spread()` management logic running on the **manual paper account only**, plus a small detector improvement to handle CSP-and-spread coexistence on the same expiry.

**Status:** Design (not yet planned).

## Goal

Teach the bot to actually *manage* the spreads it already detects: close them at profit, stop out losses, dodge assignment risk near expiration, and recover gracefully when one leg disappears unexpectedly. Enabled only on `manual` mode so it can run on the manual paper account for at least two weeks of real-cycle validation before any future plan considers enabling it on live.

## Non-goals (explicitly deferred)

The following are intentionally out of scope and belong to future plans:

- **Auto-roll logic** — Henry's video covers rolling losers down-and-out. Bot won't do this; user rolls manually.
- **`min_account_floor` / death-spiral brake** — only matters once spreads run on live ($50–200 account). Belongs to "enable spreads on live" plan.
- **Daily summary spread section** — `daily_summary.py` will continue to ignore `spread_active` entries (no crash, no rendering). Belongs to "spread visibility" plan.
- **Dashboard order form for opening spreads** — opening flow stays manual (Alpaca web or Alpaca API directly).
- **Conservative / aggressive / live enablement** — `spread_management: True` only on `manual`. All other modes stay `False`.
- **Position-size guardrails (`max_concurrent_spreads`)** — paper account has $10k starting capital; not a real concern at this scale.

## Architecture

All changes are additive to `wheel_strategy.py`. No new files. Test additions go to `tests/test_spread_management.py` (new file) so the existing `tests/test_spread_detection.py` stays focused on Phase 1.

### New functions in `wheel_strategy.py`

| Function | Responsibility |
|---|---|
| `handle_spread(state, ticker, account)` | Per-cycle decision function. Mirrors `handle_stage1` / `handle_stage2`. Fetches current snapshots, evaluates close triggers in priority order, dispatches to close helpers. |
| `_close_spread(state, ticker, reason)` | Orchestrates close. Tries mleg first, falls back to two individual orders. Updates state, fires Discord, logs JSONL. |
| `_close_spread_mleg(sym_state)` | Submits the Alpaca multi-leg (`order_class=mleg`) buy-to-close order. Returns success/failure boolean. |
| `_close_spread_legs_individually(sym_state)` | Fallback: buy-to-close short leg, then sell-to-close long leg. Each leg is a separate Alpaca order. |
| `_handle_orphan_leg(state, ticker, alpaca_positions)` | Detects "spread in state but only one leg on Alpaca," closes the survivor at market, clears state. |
| `_compute_spread_pnl(sym_state)` | Pure helper: given current snapshot mid prices on both legs, returns `(current_value, profit_pct, loss_per_share)`. Easily unit-testable. |

### Modified function in `wheel_strategy.py`

`run_wheel()` — currently iterates `SYMBOLS` and dispatches by `stage`. Add a branch:

```python
if sym_state["stage"] == "spread_active":
    if not SPREAD_MANAGEMENT:
        log(f"[{symbol}] spread present but spread_management=False — skipping")
        continue
    handle_spread(state, symbol, account)
    continue
```

`SPREAD_MANAGEMENT` is a new module-level global, populated from `config.MODES[mode]["spread_management"]` in `apply_mode()`.

### Detector improvement: narrowest-width pairing

Phase 1's `_detect_spread_pairs` uses first-match-wins greedy pairing within a `(ticker, opt_type, expiry)` bucket. If the user holds a bare CSP **and** a spread on the same ticker at the same expiry, the bucket contains 2 shorts + 1 long, and greedy pairing may pick the wrong combination.

Example (PLTR, June 19 expiry):
- Bare CSP: short $9 put
- Spread: short $8 put + long $7 put

First-match-wins pairs $9 short with $7 long ($2-wide phantom spread), leaves $8 as a bare CSP. Both wrong.

**Fix:** within each bucket, enumerate all valid candidate `(short, long)` pairs, sort by strike-width ascending, then greedy-claim. $8+$7 (width $1) wins over $9+$7 (width $2). $9 falls through to single-leg adoption correctly.

Implementation cost: ~10 lines of code change, 2 new tests.

## Decision tree — `handle_spread()`

Executes in this exact order each cycle. First trigger that fires wins; subsequent triggers don't evaluate.

```
1. Fetch current Alpaca positions.
   ├─ Both legs present       → continue to step 2
   └─ Only one leg present    → _handle_orphan_leg(state, ticker, positions) → return
   └─ Neither leg present     → clear spread state entry, log "spread fully closed externally" → return

2. Fetch latest option snapshots for short_leg.occ and long_leg.occ (mid price).
   Compute via _compute_spread_pnl:
     current_value  = short_mid - long_mid         (cost to close per share)
     profit_pct     = (net_credit - current_value) / net_credit
     loss_per_share = current_value - net_credit

3. Evaluate triggers in priority order:

   a. profit_pct >= 0.50
      → _close_spread(state, ticker, reason="early_close_50pct")

   b. loss_per_share >= max_loss * 0.50
      → _close_spread(state, ticker, reason="stop_loss_50pct")

   c. DTE <= 2 AND short_leg_ITM
      where DTE = (expiration - today).days
      and   short_leg_ITM = (spread_type=put_credit  AND stock_price < short_strike)
                         OR (spread_type=call_credit AND stock_price > short_strike)
      → _close_spread(state, ticker, reason="dte_floor_itm")

   d. otherwise
      → log heartbeat: "[ticker] spread holding — profit X%, loss Y, DTE Z"
      → no state change
```

**Thresholds (all configurable per mode but defaulted for manual):**

| Constant | Default | Source |
|---|---|---|
| `SPREAD_EARLY_CLOSE_PCT` | `0.50` | `config.MODES["manual"]["spread_early_close_pct"]` |
| `SPREAD_STOP_LOSS_PCT` | `0.50` | `config.MODES["manual"]["spread_stop_loss_pct"]` |
| `SPREAD_DTE_FLOOR` | `2` | `config.MODES["manual"]["spread_dte_floor"]` |

These get added to `config.MODES["manual"]` alongside `spread_management: True`. Other modes get them too (so the schema stays consistent) but their `spread_management: False` keeps the values inert.

## Close mechanic

### `_close_spread(state, ticker, reason)`

```
1. Attempt _close_spread_mleg(sym_state).
   ├─ Success → record close, return.
   └─ Failure (any reason) → fallback path:
        Attempt _close_spread_legs_individually(sym_state).
        ├─ Success → record close, embed footer notes "fallback path".
        └─ Failure → push #manual-errors embed, leave state alone, return.
              Next cycle will retry from the top of handle_spread.

2. On success path:
   - Delete state[ticker] entirely (not just reset — clean removal)
   - Fire #manual-trades embed (color depends on reason)
   - Fire #manual-actions embed mirror
   - log_event(LOG_STREAM, "wheel_strategy.py", "spread_closed",
               symbol=ticker, details={reason, profit_pct, close_value, ...})
```

### `_close_spread_mleg(sym_state)`

Builds an Alpaca order payload like:

```python
{
  "order_class": "mleg",
  "qty": "1",                              # spread units, not per-leg
  "type": "market",                        # close to take what we can get
  "time_in_force": "day",
  "legs": [
    {"symbol": sym_state["short_leg"]["occ"], "side": "buy",  "position_intent": "buy_to_close",  "ratio_qty": "1"},
    {"symbol": sym_state["long_leg"]["occ"],  "side": "sell", "position_intent": "sell_to_close", "ratio_qty": "1"},
  ],
}
```

Submits via the existing Alpaca POST helper. Returns `True` on HTTP 200/201, `False` on any non-success (including 422 multi-leg rejections, network errors, timeouts).

### `_close_spread_legs_individually(sym_state)`

Two sequential single-leg orders, both market, both day TIF:

```
1. buy_to_close(short_leg)
   ├─ Success → continue
   └─ Failure → push #manual-errors with "short leg close failed — spread still intact",
                return False (state unchanged, retry next cycle)

2. sell_to_close(long_leg)
   ├─ Success → return True
   └─ Failure → push #manual-errors with "ORPHANED: short closed, long stuck on Alpaca",
                update state[ticker] to mark as half-closed (short_leg.qty = 0),
                return False
```

The half-closed state allows the next cycle's `_handle_orphan_leg` to pick up the orphan long and close it.

## Orphan-leg handling

`_handle_orphan_leg(state, ticker, alpaca_positions)` fires when:
- `state[ticker]["stage"] == "spread_active"`
- AND exactly one of `{short_leg.occ, long_leg.occ}` is in Alpaca's current positions

Behavior:

```
If short_leg missing, long_leg present:
  - Reason: short was assigned overnight or expired worthless ITM-other-direction
  - Action: sell-to-close the long leg at market
  - Delete state[ticker]
  - Embed to #manual-trades: "Spread half-state resolved — short leg gone,
    closed remaining long for $X"

If long_leg missing, short_leg present:
  - Reason: long expired worthless alone (rare — would only happen if short
    was deeper ITM than long but somehow didn't trigger same-day close)
  - Action: buy-to-close the short leg at market
  - Delete state[ticker]
  - Embed to #manual-trades: "Spread half-state resolved — long leg gone,
    closed remaining short for $X"

If both missing (rare race condition):
  - Both legs closed externally between bot cycles
  - Action: delete state[ticker], no orders
  - Embed to #manual-trades: "Spread fully closed externally"
```

Detection happens at the TOP of `handle_spread` (step 1 of the decision tree) before any snapshot fetching, so a half-state never reaches the close-trigger evaluation.

## State changes after close

**Successful close → entry deleted entirely:**

```python
del state[ticker]
```

Rationale: keeps `state` clean and lets discovery re-adopt fresh if the user opens another position on the same ticker later. Avoids leaving an empty `spread_active` shell that the discovery loop would have to skip past.

The wheel's existing single-leg state (`stage: 1`/`2`) does NOT use this pattern — it preserves `cycle_history` and `total_premium_collected` across closes. Spreads diverge here because:
- Spreads are one-shot positions, not the rotating Stage 1 ↔ Stage 2 cycle the wheel runs
- Spread P&L is captured in JSONL at close time, accessible via `logs/manual.jsonl`
- No need to track cumulative-spread-premium-on-this-ticker as wheel does for the rotating wheel cycle

## Notifications

| Trigger | Channel(s) | Color | Title |
|---|---|---|---|
| Profit close (`early_close_50pct`) | `#manual-trades` + `#manual-actions` | Green | `Wheel: closed spread <TICKER> at 50% profit` |
| Stop loss (`stop_loss_50pct`) | `#manual-trades` + `#manual-actions` | Yellow | `Wheel: stopped out spread <TICKER>` |
| DTE close (`dte_floor_itm`) | `#manual-trades` + `#manual-actions` | Yellow | `Wheel: closed spread <TICKER> near expiration (ITM risk)` |
| Orphan resolved | `#manual-trades` + `#manual-actions` | Yellow | `Wheel: spread half-state resolved <TICKER>` |
| Fallback path used | `#manual-actions` only | Blue | `Wheel: spread close used fallback (mleg rejected)` |
| Close rejection | `#manual-errors` | Red | `Wheel: spread close failed <TICKER>` |
| Heartbeat (hold) | none (silent) | — | — |

JSONL events logged for all triggers above (including silent heartbeat) via `log_event(LOG_STREAM, ...)`.

## Config additions

In `config.MODES`, add to every mode (consistent schema):

```python
"spread_management":        False,   # already exists from Phase 1; flip to True for manual
"spread_early_close_pct":   0.50,
"spread_stop_loss_pct":     0.50,
"spread_dte_floor":         2,
```

Only `manual` mode sets `spread_management: True`. All other modes keep it `False` — their other thresholds are inert but present for schema consistency.

## Testing approach

New file: `tests/test_spread_management.py`. Existing `tests/test_spread_detection.py` stays focused on Phase 1 (detection + adoption + skip guard).

**Pure-function tests (no mocking needed):**
- `_compute_spread_pnl`: 4–5 scenarios covering profit, loss, breakeven, edge prices

**Handler tests (`handle_spread`, mocked snapshots + Alpaca):**
- profit ≥ 50% → close triggered with `reason="early_close_50pct"`
- loss ≥ 50% max_loss → close triggered with `reason="stop_loss_50pct"`
- DTE ≤ 2 AND short put strike > stock price → close with `reason="dte_floor_itm"` (put credit case)
- DTE ≤ 2 AND short call strike < stock price → close with `reason="dte_floor_itm"` (call credit case)
- DTE ≤ 2 but short leg OTM → hold (DTE floor only fires when ITM)
- All triggers negative → hold, no order placed
- Priority: profit takes precedence over loss takes precedence over DTE
- `spread_management: False` → `run_wheel` skips `handle_spread`, logs heartbeat only

**Close mechanic tests:**
- `_close_spread_mleg` success → state[ticker] deleted, single trades-channel embed
- `_close_spread_mleg` rejection (422) → fallback fires, both single-leg orders submitted
- Fallback both succeed → state deleted, embed footer notes "fallback used"
- Fallback short succeeds, long fails → state half-closed (short_leg.qty=0), error embed
- Fallback short fails → state untouched, error embed, retry-on-next-cycle behavior

**Orphan-leg tests:**
- Short missing, long present → long closed via sell-to-close, state deleted
- Long missing, short present → short closed via buy-to-close, state deleted
- Both missing → state deleted, no orders

**Detector disambiguation tests (added to `tests/test_spread_detection.py`):**
- Bucket with 2 shorts + 1 long where narrowest pair is the correct spread → correct pair claimed, extra short falls to single-leg
- Bucket with 1 short + 2 longs (mirror case) → narrowest-pair short claims the closer long, extra long falls to long_options_strategy (no longer in `claimed_occs`)

**Integration test:**
- Set `manual` mode, seed state with one `spread_active` entry, mock positions and snapshots so profit threshold is met, call `run_wheel`, assert close was submitted and state[ticker] deleted.

Estimated test count: 18–22 new tests. Combined with Phase 1's 19 spread tests, this gives the spread track ~40 tests at end of Phase 2.

## File structure summary

| File | Status | LOC delta (est) |
|---|---|---|
| `wheel_strategy.py` | Modify | +~300 lines (handle_spread, close helpers, orphan handler, run_wheel branch) |
| `config.py` | Modify | +~15 lines (3 new flags × 4 modes, mostly copy-paste) |
| `tests/test_spread_management.py` | Create | ~350 lines (~20 tests) |
| `tests/test_spread_detection.py` | Modify | +~50 lines (detector disambiguation tests) |
| `CLAUDE.md` | Modify | Update Spread Detection section to reflect Phase 2 ship |

## Known limitations carried forward

The Phase 1 limitations that this plan does NOT resolve:
- **Daily summary table will still misalign** for `spread_active` rows — visual only, no crash.
- **Dashboard `rule-check.ts`** still ignores `spread_active` when evaluating bot-wheel overlap on manual order placement.

The Phase 1 limitation this plan DOES resolve:
- **Split-fill qty-mismatched long legs still won't pair** — still requires `short_qty == long_qty`. Narrowest-width fix doesn't address qty mismatch. Future improvement: support partial-qty pairing (e.g., 2× short + 1× long pairs one short into the spread, leaves the other as single-leg).
- **Same-ticker / same-expiry CSP-and-spread coexistence** — resolved via narrowest-width pairing.

## Open questions

None. All design decisions confirmed in brainstorming on 2026-05-14:
1. Scope: manual paper only — confirmed
2. Profit threshold: 50% credit — confirmed
3. Stop loss: 50% max_loss — confirmed
4. DTE floor: ≤2 if short leg ITM — confirmed
5. No auto-roll — confirmed
6. Close mechanic: mleg first, fallback to singles — confirmed
7. Orphan handling: auto-close survivor — confirmed
8. Detector disambiguation: fold into Phase 2 — confirmed
