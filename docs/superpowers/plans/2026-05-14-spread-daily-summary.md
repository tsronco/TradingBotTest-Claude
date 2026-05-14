# Daily Summary Spread Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render an open-spreads section in the daily-summary Discord embed across all four modes, showing live P&L per spread. Closes the Phase 1+2 "spreads invisible to daily summary" deferred limitation.

**Architecture:** Modify `_summarize_wheel` in `daily_summary.py` to split state into single-leg symbols (existing behavior) and spread_active symbols (new). Add `_fetch_spread_pnl_for_summary` helper that calls `get_option_quote` for each leg and computes profit %. Add a new Discord embed field "Wheel — Open Spreads" rendered when spreads exist. Solves the column-alignment regression flagged in Phase 1 (no longer trying to fit `"spread_active"` into a 5-char Stage column).

**Tech Stack:** Python 3 · existing `daily_summary.py` patterns · pytest with `tests/conftest.py` fixtures (mocked Alpaca env vars + Discord webhooks).

**Spec:** Inline in this plan (small scope, no separate spec doc).

**Time pressure:** Daily summary fires at 4:12 PM ET (20:12 UTC). This plan must merge before then for AAL's first daily-summary appearance.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `daily_summary.py` | Modify | Split `_summarize_wheel`, add `_fetch_spread_pnl_for_summary`, add embed render block |
| `tests/test_daily_summary_spreads.py` | Create | Unit tests for the new helper + integration test for embed rendering |

`daily_summary.py` is currently ~590 lines. This adds ~80 lines. No file split warranted.

---

### Task 1: Split `_summarize_wheel` to separate spread_active entries

**Files:**
- Modify: `daily_summary.py` — `_summarize_wheel` function (around line 150)
- Test: `tests/test_daily_summary_spreads.py` (new file)

- [ ] **Step 1: Create the test file with first failing test**

Create `tests/test_daily_summary_spreads.py`:

```python
"""Tests for the daily summary spread-section rendering (Phase 3 of spread support)."""
import json
import pytest

import daily_summary


def _wheel_state_with_spread(tmp_path, mode_state_file: str = "wheel_state_manual.json"):
    """Write a wheel state file containing one spread_active entry + one Stage 1 single."""
    state = {
        "_meta": {"last_checked": "2026-05-14T17:00:00Z"},
        "PLTR": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0,
                          "entry_premium": 0.33, "qty": 1},
            "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0,
                          "entry_premium": 0.11, "qty": 1},
            "expiration": "2026-06-19",
            "net_credit": 0.22, "max_loss": 0.78, "width": 1.0,
            "opened_at": "2026-05-14T17:00:00Z",
            "total_premium_collected": 0.0, "cycle_count": 0,
            "cycle_history": [], "last_action": "",
        },
        "BAC": {  # Bare Stage 1 single — must NOT be in the spreads block
            "stage": 1,
            "current_contract": "BAC260522P00050000",
            "contract_entry_price": 0.29,
            "contract_qty": 1,
            "total_premium_collected": 29.0,
            "total_premium_today": 0.0,
            "cycle_count": 1,
            "shares_qty": 0,
        },
    }
    state_file = tmp_path / mode_state_file
    state_file.write_text(json.dumps(state))
    return state_file


def test_summarize_wheel_splits_spreads_from_singles(tmp_path):
    """_summarize_wheel must return both `symbols` (single-leg) and
    `spreads` (spread_active) blocks. A spread_active entry must NOT
    appear under `symbols`."""
    state_file = _wheel_state_with_spread(tmp_path)
    cfg = {"wheel_state_file": str(state_file.name)}
    # Point ROOT to tmp_path so _load_json finds the state file
    import daily_summary as ds
    original_root = ds.ROOT
    ds.ROOT = tmp_path
    try:
        result = ds._summarize_wheel(cfg)
    finally:
        ds.ROOT = original_root

    assert result["available"] is True
    assert result["format"] == "multi_stock"
    # Single-leg block — BAC only
    assert "BAC" in result["symbols"]
    assert "PLTR" not in result["symbols"], "spread_active PLTR must not be in singles"
    # New spreads block — PLTR only
    assert "spreads" in result
    assert "PLTR" in result["spreads"]
    pltr = result["spreads"]["PLTR"]
    assert pltr["spread_type"] == "put_credit"
    assert pltr["short_strike"] == 8.0
    assert pltr["long_strike"] == 7.0
    assert pltr["net_credit"] == 0.22
    assert pltr["max_loss"] == 0.78
    assert pltr["expiration"] == "2026-06-19"
    assert pltr["short_occ"] == "PLTR260619P00008000"
    assert pltr["long_occ"]  == "PLTR260619P00007000"


def test_summarize_wheel_with_no_spreads_returns_empty_spreads(tmp_path):
    """When state has zero spread_active entries, the spreads block is {}."""
    state = {
        "_meta": {},
        "BAC": {
            "stage": 1, "current_contract": "BAC260522P00050000",
            "contract_entry_price": 0.29, "contract_qty": 1,
            "total_premium_collected": 29.0, "total_premium_today": 0.0,
            "cycle_count": 1, "shares_qty": 0,
        },
    }
    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(state))
    cfg = {"wheel_state_file": str(state_file.name)}
    import daily_summary as ds
    original_root = ds.ROOT
    ds.ROOT = tmp_path
    try:
        result = ds._summarize_wheel(cfg)
    finally:
        ds.ROOT = original_root

    assert result["spreads"] == {}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_daily_summary_spreads.py -v`
Expected: FAIL — `_summarize_wheel` doesn't yet return `spreads` key.

- [ ] **Step 3: Modify `_summarize_wheel` to split state**

In `daily_summary.py`, locate `_summarize_wheel` (around line 150). The current multi-stock branch iterates state and builds `per_symbol`. Add a parallel `spreads` dict that captures entries with `stage == "spread_active"` and excludes them from `per_symbol`.

Replace the multi-stock branch (everything from `# Multi-stock format` comment to the end of the function) with:

```python
    # Multi-stock format
    per_symbol = {}
    spreads    = {}
    total_premium = 0.0
    total_today   = 0.0
    total_cycles  = 0
    for sym, sym_state in state.items():
        if sym.startswith("_") or not isinstance(sym_state, dict):
            continue
        if sym_state.get("stage") == "spread_active":
            spreads[sym] = {
                "spread_type":  sym_state.get("spread_type"),
                "short_occ":    (sym_state.get("short_leg") or {}).get("occ"),
                "long_occ":     (sym_state.get("long_leg")  or {}).get("occ"),
                "short_strike": (sym_state.get("short_leg") or {}).get("strike"),
                "long_strike":  (sym_state.get("long_leg")  or {}).get("strike"),
                "short_qty":    (sym_state.get("short_leg") or {}).get("qty"),
                "net_credit":   sym_state.get("net_credit"),
                "max_loss":     sym_state.get("max_loss"),
                "width":        sym_state.get("width"),
                "expiration":   sym_state.get("expiration"),
                "opened_at":    sym_state.get("opened_at"),
            }
            continue
        per_symbol[sym] = {
            "stage": sym_state.get("stage", 1),
            "current_contract": sym_state.get("current_contract"),
            "premium_today": sym_state.get("total_premium_today", 0),
            "total_premium": sym_state.get("total_premium_collected", 0),
            "cycle_count": sym_state.get("cycle_count", 0),
            "cost_basis": sym_state.get("cost_basis_per_share"),
        }
        total_premium += sym_state.get("total_premium_collected", 0) or 0
        total_today   += sym_state.get("total_premium_today", 0) or 0
        total_cycles  += sym_state.get("cycle_count", 0) or 0

    return {
        "available": True,
        "format": "multi_stock",
        "symbols": per_symbol,
        "spreads": spreads,
        "total_premium": round(total_premium, 2),
        "total_today":   round(total_today, 2),
        "total_cycles":  total_cycles,
    }
```

Also: the legacy single-stock branch (which only ever applied to conservative's old TSLA-only state) should return an empty `spreads` dict for schema consistency. Find the legacy branch and add `"spreads": {},` to its return dict.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_daily_summary_spreads.py -v`
Expected: 2 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`
Expected: All previously passing tests still pass; 2 new tests added.

- [ ] **Step 6: Commit**

```bash
git add daily_summary.py tests/test_daily_summary_spreads.py
git commit -m "daily-summary: split spread_active entries into separate spreads block"
```

---

### Task 2: `_fetch_spread_pnl_for_summary` helper

**Files:**
- Modify: `daily_summary.py` — new helper near other `_fetch_*` / `_get_*` helpers
- Test: `tests/test_daily_summary_spreads.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_daily_summary_spreads.py`:

```python
def test_fetch_spread_pnl_for_summary_computes_correctly(monkeypatch):
    """For a put credit spread: short_mid - long_mid = current_value,
    (net_credit - current_value) / net_credit = profit_pct."""
    spread = {
        "short_occ": "PLTR260619P00008000",
        "long_occ":  "PLTR260619P00007000",
        "net_credit": 0.22,
        "max_loss":   0.78,
        "short_qty":  1,
    }
    quotes = {
        "PLTR260619P00008000": {"bid": 0.17, "ask": 0.19},  # mid 0.18
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},  # mid 0.07
    }
    # current_value = 0.18 - 0.07 = 0.11, profit_pct = (0.22 - 0.11) / 0.22 = 0.50
    result = daily_summary._fetch_spread_pnl_for_summary(spread, quote_fn=lambda occ: quotes[occ])
    assert result["current_value"] == pytest.approx(0.11)
    assert result["profit_pct"] == pytest.approx(0.50)
    assert result["pnl_dollars"] == pytest.approx(11.0)  # (0.22 - 0.11) * 100 = $11 captured


def test_fetch_spread_pnl_for_summary_handles_missing_quote():
    """If either quote is None (no live quote), helper returns
    `current_value=None`, `profit_pct=None`, `pnl_dollars=None`
    so the embed renderer can show '—' fallback."""
    spread = {
        "short_occ": "PLTR260619P00008000",
        "long_occ":  "PLTR260619P00007000",
        "net_credit": 0.22,
        "max_loss":   0.78,
        "short_qty":  1,
    }
    # short quote missing
    result = daily_summary._fetch_spread_pnl_for_summary(
        spread, quote_fn=lambda occ: None if occ.endswith("P00008000") else {"bid": 0.06, "ask": 0.08}
    )
    assert result["current_value"] is None
    assert result["profit_pct"] is None
    assert result["pnl_dollars"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_daily_summary_spreads.py::test_fetch_spread_pnl_for_summary_computes_correctly -v`
Expected: FAIL — helper doesn't exist.

- [ ] **Step 3: Implement `_fetch_spread_pnl_for_summary`**

In `daily_summary.py`, near the other helper functions (after `_summarize_long_options` at around line 280, or wherever helpers cluster), add:

```python
def _fetch_spread_pnl_for_summary(spread: dict, quote_fn=None) -> dict:
    """Compute live P&L for one spread from Alpaca option quotes.

    Args:
        spread: dict shape from _summarize_wheel's `spreads` block.
        quote_fn: callable(occ) -> {"bid": float, "ask": float} or None.
                  Defaults to wheel_strategy.get_option_quote when None.

    Returns:
        dict with keys:
            current_value:  cost-to-close per share (None if quote missing)
            profit_pct:     0.0–1.0 fraction of credit captured (None if quote missing)
            pnl_dollars:    dollars captured = (net_credit - current_value) * 100 (None if quote missing)
    """
    if quote_fn is None:
        import wheel_strategy
        quote_fn = wheel_strategy.get_option_quote

    short_q = quote_fn(spread["short_occ"])
    long_q  = quote_fn(spread["long_occ"])
    if not short_q or not long_q:
        return {"current_value": None, "profit_pct": None, "pnl_dollars": None}

    short_mid = (short_q["bid"] + short_q["ask"]) / 2
    long_mid  = (long_q["bid"]  + long_q["ask"])  / 2
    current_value = short_mid - long_mid
    net_credit = float(spread["net_credit"])
    profit_pct = (net_credit - current_value) / net_credit if net_credit > 0 else 0.0
    pnl_dollars = (net_credit - current_value) * 100 * int(spread.get("short_qty", 1))

    return {
        "current_value": round(current_value, 4),
        "profit_pct": round(profit_pct, 4),
        "pnl_dollars": round(pnl_dollars, 2),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_daily_summary_spreads.py -v`
Expected: 4 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add daily_summary.py tests/test_daily_summary_spreads.py
git commit -m "daily-summary: add _fetch_spread_pnl_for_summary live P&L helper"
```

---

### Task 3: Render "Wheel — Open Spreads" section in the embed

**Files:**
- Modify: `daily_summary.py` — `run_daily_summary` embed building (around line 500–530)
- Test: `tests/test_daily_summary_spreads.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_daily_summary_spreads.py`:

```python
def test_embed_renders_spread_section(monkeypatch, tmp_path):
    """When wheel state has one spread_active entry, the daily summary
    embed includes a 'Wheel — Open Spreads' field with the spread details
    and live P&L."""
    # Stand up a wheel state file with one spread
    state = {
        "_meta": {},
        "PLTR": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0,
                          "entry_premium": 0.33, "qty": 1},
            "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0,
                          "entry_premium": 0.11, "qty": 1},
            "expiration": "2026-06-19",
            "net_credit": 0.22, "max_loss": 0.78, "width": 1.0,
            "opened_at": "2026-05-14T17:00:00Z",
            "total_premium_collected": 0.0, "cycle_count": 0,
            "cycle_history": [], "last_action": "",
        },
    }
    state_file = tmp_path / "wheel_state_manual.json"
    state_file.write_text(json.dumps(state))

    # Stub all the Alpaca-touching helpers so the test stays offline
    import daily_summary as ds
    monkeypatch.setattr(ds, "ROOT", tmp_path)
    monkeypatch.setattr(ds, "_get_account", lambda cfg: {"cash": "10000", "equity": "10000"})
    monkeypatch.setattr(ds, "_get_positions", lambda cfg: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    monkeypatch.setattr(ds, "_summarize_strategy", lambda cfg: {"available": False})
    monkeypatch.setattr(ds, "_summarize_long_options", lambda cfg: {"available": False, "count": 0})
    monkeypatch.setattr(ds, "_summarize_held_stocks", lambda cfg, tracked: {"available": False})
    monkeypatch.setattr(ds, "_summarize_congress", lambda: {"available": False})
    # Stub the spread quote fetch
    import wheel_strategy
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda occ: {
        "PLTR260619P00008000": {"bid": 0.17, "ask": 0.19},
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},
    }[occ])

    # Capture the embed payload
    captured = {}
    monkeypatch.setattr(ds, "send_embed",
                        lambda ch, title, **kw: captured.update({"title": title, **kw}))

    # Ensure manual mode is set in config so wheel_state_manual.json is the target
    import config
    config.MODES["manual"]["wheel_state_file"] = "wheel_state_manual.json"

    ds.run_daily_summary("manual")

    fields = captured.get("fields", [])
    spread_field = next((f for f in fields if "spread" in f["name"].lower()), None)
    assert spread_field is not None, "no 'Open Spreads' field found in embed"
    # The rendered table should contain the symbol, strikes, credit, and a profit %
    value = spread_field["value"]
    assert "PLTR" in value
    assert "$8" in value or "8.00" in value
    assert "$7" in value or "7.00" in value
    assert "50%" in value or "50.0%" in value or "0.50" in value, \
        "expected 50% profit displayed for spread at half credit"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_daily_summary_spreads.py::test_embed_renders_spread_section -v`
Expected: FAIL — no spread field in the embed.

- [ ] **Step 3: Add the embed rendering block**

In `daily_summary.py`, find the embed field-building section inside `run_daily_summary` (around line 500). Locate this block:

```python
        if wheel["available"]:
            fields.append({
                "name": "Wheel — All Symbols (totals)",
                ...
```

After the existing per-symbol rendering block (around line 530, just before the `if long_opts.get("available")` block), insert a new spreads-rendering block:

```python
        if wheel.get("available") and wheel.get("spreads"):
            from datetime import date as _date
            spread_rows = []
            for sym, sp in wheel["spreads"].items():
                pnl = _fetch_spread_pnl_for_summary(sp)
                # DTE calc
                try:
                    expiry = _date.fromisoformat(sp["expiration"])
                    dte = (expiry - _date.today()).days
                except (ValueError, TypeError):
                    dte = "?"
                # Format P&L cells; "—" if quote was unavailable
                if pnl["profit_pct"] is None:
                    profit_str = "—"
                    pnl_str = "—"
                else:
                    profit_str = f"{pnl['profit_pct']*100:+.0f}%"
                    pnl_str = f"${pnl['pnl_dollars']:+,.2f}"
                spread_rows.append({
                    "sym":    sym,
                    "type":   (sp["spread_type"] or "").replace("_", " "),
                    "strikes": f"${sp['short_strike']:.2f}/${sp['long_strike']:.2f}",
                    "credit": f"${sp['net_credit']:.2f}",
                    "profit": profit_str,
                    "pnl":    pnl_str,
                    "dte":    dte,
                })
            if spread_rows:
                lines = [
                    f"{'Sym':<5}  {'Type':<11}  {'Strikes':<13}  {'Credit':>7}  {'P&L%':>6}  {'P&L $':>9}  {'DTE':>4}",
                    f"{'-'*5}  {'-'*11}  {'-'*13}  {'-'*7}  {'-'*6}  {'-'*9}  {'-'*4}",
                ]
                for r in spread_rows:
                    lines.append(
                        f"{r['sym']:<5}  {r['type']:<11}  {r['strikes']:<13}  "
                        f"{r['credit']:>7}  {r['profit']:>6}  {r['pnl']:>9}  {str(r['dte']):>4}"
                    )
                fields.append({
                    "name":  f"Wheel — Open Spreads ({len(spread_rows)})",
                    "value": "```\n" + "\n".join(lines) + "\n```",
                    "inline": False,
                })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_daily_summary_spreads.py -v`
Expected: 5 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ --tb=line`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add daily_summary.py tests/test_daily_summary_spreads.py
git commit -m "daily-summary: render Open Spreads section with live P&L"
```

---

### Task 4: Smoke test against the live AAL spread

**Files:**
- No code changes — pure verification

- [ ] **Step 1: Run the manual daily summary against the actual AAL spread**

```bash
python daily_summary.py --mode manual
```

This will pull the real wheel state (which has the AAL spread adopted), fetch live quotes for both legs, and post the embed to `#manual-summary`.

Expected output in Discord:
- The existing strategy/wheel/long-options/held-stocks sections render as usual
- A new `Wheel — Open Spreads (1)` field appears with a single row for AAL:
  - `AAL  put credit  $12.50/$11.50  $0.25  +X%  $+Y  ZZ` (where X/Y/Z reflect today's market)

- [ ] **Step 2: Verify Discord output looks right**

If the spread row renders cleanly (no column overflow, plausible profit %, sensible DTE), proceed to PR.

If anything looks off (column misalignment, "—" everywhere, garbled values), STOP and report the issue.

---

### Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Spreads section to remove the "daily summary table will misalign" limitation and reference the new section**

In `CLAUDE.md`, find the Spreads section. Replace:

```
**Known limitations:**
- Daily summary table will still misalign for `spread_active` rows (cosmetic, no crash).
- Split-fill long legs (`short_qty != long_qty`) won't pair — falls through to single-leg adoption.
```

With:

```
**Known limitations:**
- Split-fill long legs (`short_qty != long_qty`) won't pair — falls through to single-leg adoption.
```

(Daily summary alignment is now fixed — spreads render in their own section.)

Also update the "What's NOT yet implemented" list — remove the "Daily summary spread section" bullet since it now IS implemented.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: spread daily summary shipped; refresh CLAUDE.md limitations"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

Run: `python -m pytest tests/ -v --tb=short`
Expected: All passing, +5 new tests in `test_daily_summary_spreads.py`.

- [ ] **Step 2: Push and PR**

Branch: `claude/spread-daily-summary`. Open PR against main. Merge before 4:12 PM ET so the live AAL spread renders in today's manual summary.

---

## Out-of-scope deferrals

- Aggregate P&L across all spreads (just sum the per-spread `pnl_dollars`) — could add but YAGNI for now
- Color-coding the embed for spreads in profit vs. loss — visual nice-to-have, not needed
- Spread close history rolled up in summary — that's already in JSONL logs; can add to summary in a future plan
