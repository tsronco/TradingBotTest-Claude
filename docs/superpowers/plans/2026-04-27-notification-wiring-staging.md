---
title: Notification + Logging Wiring — Staged Edits
date: 2026-04-27
status: STAGED — apply Tuesday/Wednesday evening
related_plan: 2026-04-26-hosted-routines-migration.md
---

# Staged Wiring: Discord + JSONL Helpers Into Trading Scripts

This doc lists every edit needed to wire `notifications.send_embed` /
`notifications.log_event` into the live trading scripts. **Nothing in this
doc has been applied yet** — it's pre-staged so the actual edit session
goes fast.

## Order of operations on apply day

1. Confirm `.env` has all 5 `DISCORD_*_WEBHOOK` keys.
2. Apply edits in this order (small → big, easy rollback):
   - `strategy.py` (~6 hooks)
   - `wheel_strategy.py` (~10 hooks)
   - `congress-copy/src/trader.py` (~4 hooks)
   - `congress-copy/src/monitor.py` (~3 hooks)
   - `congress-copy/src/runner.py` (~2 hooks for top-level errors)
3. Run each script once locally with `--dry-run` or by triggering the
   scheduled task manually. Verify Discord pings and JSONL lines.
4. Commit. Don't push until all five files green.

## Channel + stream conventions

| Script | Discord channel | JSONL stream |
|---|---|---|
| `strategy.py` (TSLA stock) | `tsla` | `tsla` |
| `wheel_strategy.py` (TSLA options) | `tsla` | `tsla` |
| `congress-copy/*` (trader + monitor) | `congress` | `congress` |
| `daily_summary.py` (TBD) | `summary` | `daily-summary` |
| Any uncaught exception, anywhere | `errors` | `errors` |

Every Discord call defaults to also-mirror to `#all-actions`, so the
firehose channel needs zero extra code.

## Color conventions (from notifications.Color)

| Event class | Color |
|---|---|
| Fill / sold / profit / expired worthless | `GREEN` |
| Stop hit / loss / API failure / rejected order | `RED` |
| Order placed but unfilled / pending / warning | `YELLOW` |
| Heartbeat / "no action" / position checked clean | `BLUE` |

---

## Edits to `strategy.py` (TSLA trailing stop + ladder)

### Top of file (after imports)

```python
from notifications import send_embed, log_event, Color
```

### Hook A — entry fill detected (inside `wait_for_fill`, after the "Filled" log line)

```python
send_embed(
    "tsla", f"TSLA Entry Filled — {fill_qty} shares @ ${fill_price:.2f}",
    color=Color.GREEN,
    fields=[
        {"name": "Order ID", "value": order_id, "inline": False},
        {"name": "Stop", "value": f"${recalculate_stop(fill_price):.2f}", "inline": True},
        {"name": "Trail trigger", "value": f"${fill_price * (1 + TRAIL_TRIGGER_PCT):.2f}", "inline": True},
    ],
    footer="strategy.py",
)
log_event("tsla", "strategy.py", "entry_filled",
          symbol=SYMBOL,
          details={"qty": fill_qty, "fill_price": fill_price},
          alpaca_order_id=order_id)
```

### Hook B — stop hit (inside main loop, immediately after `close_all(SYMBOL)`)

```python
send_embed(
    "tsla", f"TSLA STOP HIT — closed {total_qty} shares @ ${price:.2f}",
    color=Color.RED,
    description=f"Realized P&L: ${realized:+.2f}",
    fields=[
        {"name": "Avg cost", "value": f"${avg_cost:.2f}", "inline": True},
        {"name": "Stop was", "value": f"${stop_price:.2f}", "inline": True},
    ],
    footer="strategy.py",
)
log_event("tsla", "strategy.py", "stop_hit",
          symbol=SYMBOL, result="success",
          details={"exit_price": price, "qty": total_qty, "realized_pnl": realized})
```

### Hook C — trailing stop activated (after the "Trailing ACTIVATED" log)

```python
send_embed(
    "tsla", "TSLA Trailing Stop Activated",
    color=Color.BLUE,
    description=f"Price ${price:.2f} hit +{TRAIL_TRIGGER_PCT*100:.0f}% from entry. Floor will trail 5% below high-water mark.",
    footer="strategy.py",
)
log_event("tsla", "strategy.py", "trail_activated",
          symbol=SYMBOL, details={"price": price, "entry_price": entry_price})
```

### Hook D — stop raised by trailing (inside trailing branch, when new_stop > stop_price)

```python
send_embed(
    "tsla", f"TSLA Stop Raised → ${new_stop:.2f}",
    color=Color.BLUE,
    description=f"HWM ${high_water_mark:.2f} (was ${stop_price:.2f})",
    footer="strategy.py",
)
log_event("tsla", "strategy.py", "stop_raised",
          symbol=SYMBOL, details={"old_stop": float(stop_price), "new_stop": new_stop, "hwm": high_water_mark})
```

### Hook E — ladder triggered (inside ladder loop, after `place_order`)

```python
send_embed(
    "tsla", f"TSLA {ldr['label']} Triggered — bought {qty} shares @ ${price:.2f}",
    color=Color.YELLOW,  # yellow because order is just placed, not yet filled
    fields=[
        {"name": "New avg cost", "value": f"${avg_cost:.2f}", "inline": True},
        {"name": "New stop", "value": f"${new_stop:.2f}", "inline": True},
        {"name": "Total qty", "value": str(total_qty), "inline": True},
    ],
    footer="strategy.py",
)
log_event("tsla", "strategy.py", "ladder_triggered",
          symbol=SYMBOL,
          details={"label": ldr["label"], "qty": qty, "price": price, "new_avg_cost": avg_cost},
          alpaca_order_id=o["id"])
```

### Hook F — caught exception in main loop (inside `except Exception as e`)

```python
send_embed(
    "errors", "strategy.py — exception in main loop",
    color=Color.RED,
    description=f"`{type(e).__name__}: {str(e)[:500]}`",
    footer="strategy.py",
)
log_event("errors", "strategy.py", "exception",
          result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
```

---

## Edits to `wheel_strategy.py` (TSLA cash-secured puts + covered calls)

### Top of file (after imports)

```python
from notifications import send_embed, log_event, Color
```

### Hook G — new put sold (inside `_sell_new_put`, after `place_sell_to_open`)

```python
send_embed(
    "tsla", f"Wheel: Sold-to-Open Put @ ${contract['strike_price']}",
    color=Color.YELLOW,
    description=f"Contract: {symbol}\nLimit: ${limit_price:.2f}",
    fields=[
        {"name": "Strike", "value": f"${contract['strike_price']}", "inline": True},
        {"name": "Expiry", "value": contract["expiration_date"], "inline": True},
        {"name": "TSLA price", "value": f"${tsla_price:.2f}", "inline": True},
    ],
    footer="wheel_strategy.py",
)
log_event("tsla", "wheel_strategy.py", "sold_put",
          symbol=symbol,
          details={"strike": float(contract["strike_price"]), "expiry": contract["expiration_date"], "limit_price": limit_price, "tsla_price": tsla_price},
          alpaca_order_id=order["id"])
```

### Hook H — insufficient cash to sell put (inside `_sell_new_put`, in the cash check)

```python
send_embed(
    "errors", "Wheel: Insufficient Cash for New Put",
    color=Color.RED,
    description=f"Need ${cash_required:,.0f}, have ${cash:,.0f}",
    footer="wheel_strategy.py",
)
log_event("errors", "wheel_strategy.py", "insufficient_cash",
          result="failure", details={"need": cash_required, "have": cash})
```

### Hook I — put expired worthless (inside `handle_stage1`)

```python
send_embed(
    "tsla", f"Wheel: Put Expired Worthless — kept ${premium_dollars:.2f}",
    color=Color.GREEN,
    description=f"{contract}\nTotal premium collected: ${state['total_premium_collected']:.2f}",
    footer="wheel_strategy.py",
)
log_event("tsla", "wheel_strategy.py", "put_expired_worthless",
          symbol=contract,
          details={"premium": premium_dollars, "total_premium": state["total_premium_collected"]})
```

### Hook J — put assigned (inside `handle_stage1`)

```python
send_embed(
    "tsla", f"Wheel: PUT ASSIGNED — now hold 100 TSLA @ ${cost:.2f}",
    color=Color.YELLOW,
    description=f"Contract: {contract}\nMoving to Stage 2 (covered calls).",
    footer="wheel_strategy.py",
)
log_event("tsla", "wheel_strategy.py", "put_assigned",
          symbol=contract,
          details={"cost_basis": cost, "qty": 100})
```

### Hook K — early-close 50% profit (inside `handle_stage1`, after `place_buy_to_close`)

```python
send_embed(
    "tsla", f"Wheel: Early Close at 50% Profit — +${premium_dollars:.2f}",
    color=Color.GREEN,
    description=f"{contract}\nClosed @ ${current_price:.2f} (entry ${entry:.2f})",
    footer="wheel_strategy.py",
)
log_event("tsla", "wheel_strategy.py", "early_close_50pct",
          symbol=contract,
          details={"entry": float(entry), "exit": current_price, "premium": premium_dollars})
```

### Hook L — covered call sold (inside `_sell_new_call`)

```python
send_embed(
    "tsla", f"Wheel: Sold-to-Open Call @ ${contract['strike_price']}",
    color=Color.YELLOW,
    description=f"Contract: {symbol}\nLimit: ${limit_price:.2f}",
    fields=[
        {"name": "Strike", "value": f"${contract['strike_price']}", "inline": True},
        {"name": "Expiry", "value": contract["expiration_date"], "inline": True},
        {"name": "Cost basis", "value": f"${cost_basis:.2f}", "inline": True},
    ],
    footer="wheel_strategy.py",
)
log_event("tsla", "wheel_strategy.py", "sold_call",
          symbol=symbol,
          details={"strike": float(contract["strike_price"]), "expiry": contract["expiration_date"], "limit_price": limit_price, "cost_basis": cost_basis},
          alpaca_order_id=order["id"])
```

### Hook M — call assigned / shares called away (inside `handle_stage2`)

```python
send_embed(
    "tsla", f"Wheel: CALL ASSIGNED — shares sold @ strike ${state['contract_strike']:.0f}",
    color=Color.GREEN,
    description=f"+${premium_dollars:.2f} premium kept. Returning to Stage 1.",
    footer="wheel_strategy.py",
)
log_event("tsla", "wheel_strategy.py", "call_assigned",
          symbol=contract,
          details={"strike": state["contract_strike"], "premium": premium_dollars})
```

### Hook N — call expired worthless (inside `handle_stage2`)

```python
send_embed(
    "tsla", f"Wheel: Call Expired Worthless — kept ${premium_dollars:.2f}",
    color=Color.GREEN,
    description=f"{contract}\nTotal premium collected: ${state['total_premium_collected']:.2f}",
    footer="wheel_strategy.py",
)
log_event("tsla", "wheel_strategy.py", "call_expired_worthless",
          symbol=contract,
          details={"premium": premium_dollars, "total_premium": state["total_premium_collected"]})
```

### Hook O — heartbeat at end of `run_wheel` (always fires)

Inside `run_wheel()` just before `save_state(state)`:

```python
log_event("tsla", "wheel_strategy.py", "cycle_complete", result="success",
          details={"stage": state["stage"], "contract": state.get("current_contract"), "tsla_price": price})
```

(No Discord ping for heartbeat — too noisy. JSONL only. Consider a Discord
heartbeat for the first month per open question #5 in the migration plan,
then turn it off once we trust the system.)

### Hook P — top-level exception wrapper (wrap the body of `run_wheel` and `run_daily_summary`)

```python
try:
    # ...existing body...
except Exception as e:
    send_embed(
        "errors", f"wheel_strategy.py — {func_name} crashed",
        color=Color.RED,
        description=f"`{type(e).__name__}: {str(e)[:500]}`",
        footer="wheel_strategy.py",
    )
    log_event("errors", "wheel_strategy.py", "exception",
              result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
    raise
```

---

## Edits to `congress-copy/src/trader.py`

### Top of file (after imports)

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from notifications import send_embed, log_event, Color
```

(Path insertion needed because `congress-copy/` is a separate package and
`notifications/` lives at the project root.)

### Hook Q — new disclosure detected and copy trade placed

```python
send_embed(
    "congress", f"Congress Copy: Bought {symbol} — ${dollars} committed",
    color=Color.YELLOW,
    description=f"Source: Gottheimer disclosure {trade_id}\nFiled: {filed_at}",
    fields=[
        {"name": "Side", "value": side, "inline": True},
        {"name": "Asset", "value": asset_kind, "inline": True},
        {"name": "Range", "value": f"${range_lo:,.0f}–${range_hi:,.0f}", "inline": False},
    ],
    footer="trader.py",
)
log_event("congress", "trader.py", "copy_trade_placed",
          symbol=symbol,
          details={"side": side, "dollars": dollars, "trade_id": trade_id, "asset_kind": asset_kind})
```

### Hook R — disclosure skipped (stale, already seen, options-fallback rejected, etc.)

```python
log_event("congress", "trader.py", "disclosure_skipped",
          symbol=symbol, result="skipped",
          notes=f"reason={reason}")
```

(JSONL only — stale disclosures are routine, no Discord noise.)

### Hook S — order rejected by Alpaca

```python
send_embed(
    "errors", f"Congress Copy: Order REJECTED for {symbol}",
    color=Color.RED,
    description=f"`{reason}`",
    footer="trader.py",
)
log_event("errors", "trader.py", "order_rejected",
          symbol=symbol, result="failure", notes=reason)
```

### Hook T — top-level exception in trader run

Same shape as Hook P, scoped to `trader.py`.

---

## Edits to `congress-copy/src/monitor.py`

### Top of file (after imports)

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from notifications import send_embed, log_event, Color
```

### Hook U — stop-loss fired (after `mark_stopped_out`)

```python
send_embed(
    "congress", f"Congress Copy: STOP HIT — closed {pos.symbol}",
    color=Color.RED,
    description=f"Drawdown: {float(drawdown)*100:.2f}%\nExit: ${pos.current_price}",
    footer="monitor.py",
)
log_event("congress", "monitor.py", "stop_loss_fired",
          symbol=pos.symbol, result="success",
          details={"drawdown_pct": float(drawdown), "exit_price": float(pos.current_price), "entry": float(entry)})
```

### Hook V — monitor cycle complete (heartbeat at end of `run_monitor_cycle`)

```python
log_event("congress", "monitor.py", "cycle_complete", result="success",
          details=summary)
```

### Hook W — fetch error (inside the early-return except block)

```python
send_embed(
    "errors", "Congress Copy Monitor: fetch error",
    color=Color.RED,
    description=f"`{str(e)[:500]}`",
    footer="monitor.py",
)
log_event("errors", "monitor.py", "fetch_error",
          result="failure", notes=str(e)[:500])
```

---

## Edits to `congress-copy/src/runner.py`

Wrap each subcommand dispatch (`disclosures`, `monitor`) in a try/except
that pings `#errors` on uncaught exceptions, mirroring Hook F shape.

---

## What I'm explicitly NOT doing

- **Not changing any trading logic.** Every hook is purely additive.
- **Not removing existing `log()` print statements.** They keep working as
  console output during local runs and during GitHub Actions.
- **Not gating with a feature flag.** The `discord.py` helper already
  no-ops when env vars are unset, so dropping it into a local run without
  the webhooks set is safe. The JSONL logger is harmless even if no one
  ever reads `logs/*.jsonl`.

## Apply-day checklist

- [ ] Confirm `.env` has all 5 webhook URLs (you've already tested they work)
- [ ] Apply Hooks A–F to `strategy.py`
- [ ] Apply Hooks G–P to `wheel_strategy.py`
- [ ] Apply Hooks Q–T to `congress-copy/src/trader.py`
- [ ] Apply Hooks U–W to `congress-copy/src/monitor.py`
- [ ] Apply runner.py wrapper
- [ ] Run `python -m pytest` in `congress-copy/` — all monitor tests should still pass (the new imports don't break the test fixtures because env vars are unset in tests, so Discord no-ops)
- [ ] Manually trigger each scheduled task and verify Discord pings appear in expected channels
- [ ] Verify `logs/tsla.jsonl`, `logs/congress.jsonl`, `logs/errors.jsonl` get written
- [ ] Commit with message `wire notifications + jsonl logging into trading scripts`
