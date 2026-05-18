# SM Universe + sm500 Risk + Spread Embed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sm500 able to open spreads, give all three SM accounts a deeper candidate pool, and replace the wall-of-text spread Discord messages with clean structured cards.

**Architecture:** Three independent changes plus a shared embed helper. (A) Expand `screener_core.DEFAULT_CONSERVATIVE_UNIVERSE` ~62→~113 with a packed ≤$25 tier. (B) Raise sm500 `max_risk_pct_equity` 0.15→0.20 and switch the auto-open risk gate from gross `width×100` to net-of-credit `(width−net_credit)×100`, which requires fetching the long-leg quote before the risk check. (C) Extract a pure `_spread_embed_fields()` helper and use it for both the auto-spread *opened* and the spread *adoption* embeds.

**Tech Stack:** Python 3.12, pytest, Alpaca REST (mocked in tests), Discord webhooks (mocked in tests).

**Spec:** `docs/superpowers/specs/2026-05-18-sm-universe-risk-embed-design.md`

---

## File Structure

- `screener_core.py` — Task 1: expand `DEFAULT_CONSERVATIVE_UNIVERSE`.
- `tests/test_screener_core.py` — Task 1: widen `test_universe_size_and_quality` bounds + cheap-tier assertion.
- `config.py` — Task 2: sm500 `max_risk_pct_equity` 0.15→0.20 (sm1000/sm2000 unchanged).
- `tests/test_modes_sm.py` — Task 2: add sm500 0.20 assertion.
- `wheel_strategy.py` — Task 3: new `spread_passes_risk` signature + reorder width loop; Task 4: add `_spread_embed_fields` + reformat both embeds.
- `tests/test_auto_spread.py` — Task 3: rewrite `test_spread_passes_risk_exact_arithmetic`; Task 4: add `test_spread_embed_fields`.

Run the suite with: `python -m pytest tests/ -q` (full) or the targeted node IDs shown per step.

---

## Task 1: Expand the screener universe

**Files:**
- Modify: `screener_core.py:37-75` (`DEFAULT_CONSERVATIVE_UNIVERSE`)
- Test: `tests/test_screener_core.py:60-74` (`test_universe_size_and_quality`)

- [ ] **Step 1: Update the failing test first**

Replace `tests/test_screener_core.py:60-74` (the whole `test_universe_size_and_quality` body) with:

```python
def test_universe_size_and_quality():
    """Expanded universe: 105-130 names, valid/unique, ≥30 cheap (≤$25) names."""
    u = screener_core.DEFAULT_CONSERVATIVE_UNIVERSE
    assert 105 <= len(u) <= 130, f"Universe size {len(u)} not in [105, 130]"
    assert all(isinstance(s, str) and s == s.upper() and len(s) > 0 for s in u)
    assert len(u) == len(set(u)), "Universe has duplicates"
    KNOWN_CHEAP = {
        "F", "T", "INTC", "SOFI", "PFE", "BAC", "NIO", "CCL", "KMI", "AAL",
        "NOK", "SNAP", "WBD", "PARA", "NCLH", "HOOD", "RIVN", "CLF", "VALE",
        "KGC", "GOLD", "AES", "KEY", "RF", "HBAN", "FITB", "ALLY", "SYF",
        "MOS", "SIRI", "KSS", "M", "HPE", "GRAB",
    }
    present_cheap = KNOWN_CHEAP & set(u)
    assert len(present_cheap) >= 30, (
        f"Only {len(present_cheap)} cheap names: {sorted(present_cheap)}; need ≥30"
    )
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_screener_core.py::test_universe_size_and_quality -q`
Expected: FAIL — current universe is ~62 (size assertion fails) and lacks the new cheap names.

- [ ] **Step 3: Replace the universe literal**

Replace the entire `DEFAULT_CONSERVATIVE_UNIVERSE: list[str] = sorted({ ... })` block at `screener_core.py:37-75` with:

```python
DEFAULT_CONSERVATIVE_UNIVERSE: list[str] = sorted({
    # ── Tech / semis (large-cap, liquid options) ──
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AMD", "INTC", "ORCL",
    "CRM", "ADBE", "IBM", "CSCO", "MU", "AVGO", "QCOM", "TXN", "AMAT",
    "KLAC", "LRCX", "PYPL", "HPQ", "DELL", "MRVL", "NXPI", "MCHP", "ADI",
    "FTNT", "PANW", "CRWD", "SHOP", "ABNB", "NFLX",
    # ── Banks / finance ──
    "JPM", "WFC", "C", "GS", "AXP", "V", "MA", "BAC", "MS", "BLK", "SCHW",
    "USB", "PNC", "TFC",
    # ── Energy / materials ──
    "CVX", "COP", "XOM", "KMI", "OXY", "SLB", "HAL", "NEM", "DOW", "LYB",
    # ── Consumer / retail ──
    "PEP", "WMT", "COST", "NKE", "MCD", "SBUX", "HD", "DIS", "TGT", "LOW",
    "KO", "PG", "MDLZ",
    # ── Telecom ──
    "T", "VZ",
    # ── Healthcare (mature large-cap; no biotech) ──
    "JNJ", "UNH", "MRK", "ABBV", "PFE", "CVS", "MDT", "BMY", "GILD",
    "AMGN", "ABT",
    # ── Auto / industrial / defense ──
    "F", "GM", "CAT", "DE", "HON", "GE", "RTX", "LMT",
    # ── Mobility / misc large-cap ──
    "UBER", "LYFT", "PLTR",
    # ── ≤$25 tier (sm500-eligible: liquid options, would own at assignment) ──
    "SOFI", "NIO", "CCL", "AAL", "NOK", "SNAP", "WBD", "PARA", "NCLH",
    "HOOD", "RIVN", "CLF", "VALE", "KGC", "GOLD", "AES", "KEY", "RF",
    "HBAN", "FITB", "ALLY", "SYF", "MOS", "SIRI", "KSS", "M", "HPE",
    "GRAB",
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_screener_core.py -q`
Expected: PASS (all screener_core tests, including `test_build_universe_uses_default_when_cfg_is_none` which derives from the literal).

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ -q`
Expected: PASS. (No other test hardcodes the old universe length; `test_modes_sm` does not assert universe contents.)

- [ ] **Step 6: Commit**

```bash
git add screener_core.py tests/test_screener_core.py
git commit -m "feat: expand screener universe ~62->~113, pack ≤\$25 tier for sm500"
```

---

## Task 2: Raise sm500 risk ceiling to 20%

**Files:**
- Modify: `config.py:383` (sm500 `max_risk_pct_equity`)
- Test: `tests/test_modes_sm.py:36-51` (`test_auto_open_param_block_defaults`)

- [ ] **Step 1: Add the failing assertion**

In `tests/test_modes_sm.py`, inside `test_auto_open_param_block_defaults`, immediately after the line `assert c["max_risk_pct_equity"] == 0.15` (this `c` is sm1000 — leave it 0.15), add:

```python
    # sm500 runs a higher per-trade risk ceiling so a $1-wide spread fits
    assert config.get_mode("sm500")["max_risk_pct_equity"] == 0.20
    assert config.get_mode("sm2000")["max_risk_pct_equity"] == 0.15
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_modes_sm.py::test_auto_open_param_block_defaults -q`
Expected: FAIL — sm500 is currently 0.15, assertion expects 0.20.

- [ ] **Step 3: Change sm500 config**

In `config.py:383`, change the sm500 block line (the one with the `# max loss / equity ≤ 15%` comment) from:

```python
        "max_risk_pct_equity":       0.15,    # max loss / equity ≤ 15%
```

to:

```python
        "max_risk_pct_equity":       0.20,    # max loss / equity ≤ 20% (sm500 only — fits a $1-wide spread)
```

Leave `config.py:439` (sm1000) and `config.py:494` (sm2000) at `0.15`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_modes_sm.py -q`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `python -m pytest tests/ -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config.py tests/test_modes_sm.py
git commit -m "feat: sm500 max_risk_pct_equity 15%->20% so a \$1-wide spread can fit"
```

---

## Task 3: Net-of-credit risk gate + width-loop reorder

**Files:**
- Modify: `wheel_strategy.py:1973-1975` (`spread_passes_risk`)
- Modify: `wheel_strategy.py:2149-2186` (width-search loop in `_auto_open_spread`)
- Test: `tests/test_auto_spread.py:44-53` (`test_spread_passes_risk_exact_arithmetic`)

- [ ] **Step 1: Rewrite the failing test**

Replace `tests/test_auto_spread.py:44-53` (the whole `test_spread_passes_risk_exact_arithmetic` body) with:

```python
def test_spread_passes_risk_exact_arithmetic():
    # max loss = (width - net_credit) * 100; pass iff <= equity * max_risk_pct
    # $1 wide, $0.10 credit on $500 @ 20%: (1.00-0.10)*100=90 <= 100 -> True
    assert ws.spread_passes_risk(1.0, 0.10, 500, 0.20) is True
    # same spread on $500 @ 15%: 90 <= 75 -> False (why sm500 was stuck)
    assert ws.spread_passes_risk(1.0, 0.10, 500, 0.15) is False
    # zero credit makes it gross-width again: 100 > 100*1? $1 wide $1000 @ 0.10: 100 <= 100 -> True
    assert ws.spread_passes_risk(1.0, 0.0, 1000, 0.10) is True
    # net-of-credit is looser than gross: $1.20 wide, $0.30 credit, $1000 @ 0.10
    #   gross 120 > 100 (old: False) but net (1.20-0.30)*100=90 <= 100 -> True
    assert ws.spread_passes_risk(1.2, 0.30, 1000, 0.10) is True
    # negative/over-wide still rejected: $2 wide, $0.05 credit, $1000 @ 0.15: 195 > 150 -> False
    assert ws.spread_passes_risk(2.0, 0.05, 1000, 0.15) is False
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_auto_spread.py::test_spread_passes_risk_exact_arithmetic -q`
Expected: FAIL — `spread_passes_risk` currently takes 3 args `(width, equity, max_risk_pct)`; calling with 4 raises `TypeError`.

- [ ] **Step 3: Rewrite `spread_passes_risk`**

Replace `wheel_strategy.py:1973-1975` (the whole function) with:

```python
def spread_passes_risk(width: float, net_credit: float, equity: float,
                        max_risk_pct: float) -> bool:
    """Net-of-credit max loss ((width - net_credit) * 100) must be ≤ this
    fraction of account equity. Matches the canonical max_loss convention
    used by _adopt_spread / _auto_open_spread state seeding."""
    max_loss = (width - net_credit) * 100.0
    return max_loss <= equity * max_risk_pct
```

- [ ] **Step 4: Reorder the width-search loop so the credit is known at the risk check**

Replace `wheel_strategy.py:2155-2181` (the `for step in range(1, max_steps + 1):` loop body, from `for step` through the `break  # first hit == narrowest passing width`) with:

```python
        for step in range(1, max_steps + 1):
            long_target = short_strike - inc * step
            if long_target <= 0:
                break
            long_contract = find_best_contract(sym, "put", long_target,
                                                dte_min, dte_max)
            if not long_contract:
                continue
            long_strike = float(long_contract["strike_price"])
            width = round(short_strike - long_strike, 4)
            if width <= 0:
                continue
            # Need the long quote BEFORE the risk check: the gate now uses
            # net-of-credit max loss, so net_credit must be known here.
            long_q = get_option_quote(long_contract["symbol"])
            if not long_q:
                continue
            long_mid = (long_q["bid"] + long_q["ask"]) / 2.0
            cand_net_credit = round(short_mid - long_mid, 4)
            if not spread_passes_risk(width, cand_net_credit, equity,
                                      max_risk_pct):
                continue
            if not bp_fits(options_bp, width):
                continue
            chosen = {
                "long_occ":    long_contract["symbol"],
                "long_strike": long_strike,
                "long_mid":    long_mid,
                "width":       width,
            }
            break  # first hit == narrowest passing width
```

(Everything after the loop — `if not chosen:`, `net_credit = round(short_mid - chosen["long_mid"], 4)`, the `min_net_credit` check, `max_loss = round(width - net_credit, 4)`, the order placement — is unchanged. `bp_fits(options_bp, width)` stays width-based: spread collateral is the full width, not net of credit.)

- [ ] **Step 5: Run targeted tests to verify they pass**

Run: `python -m pytest tests/test_auto_spread.py -q`
Expected: PASS — including the existing `test_auto_open_happy_path_opens_one_spread`, `test_auto_open_earnings_block_skips_to_next`, `test_auto_open_net_credit_at_floor_accepted`, `test_auto_open_max_one_per_cycle` (these mock `get_option_quote`/`find_best_contract`; the reorder keeps the same call set, so mocks still satisfy it).

If any happy-path auto-open test fails because its mock returned a quote in a different call order, fix the test's mock sequencing (do NOT change production code) so `get_option_quote` is mocked for the long leg inside the loop. Re-run until green.

- [ ] **Step 6: Run the full suite**

Run: `python -m pytest tests/ -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "feat: risk gate uses net-of-credit max loss; reorder width loop to know credit first"
```

---

## Task 4: Clean structured spread embeds

**Files:**
- Modify: `wheel_strategy.py` — add `_spread_embed_fields` helper (place it directly above `def _open_spread_mleg` at `wheel_strategy.py:1997`)
- Modify: `wheel_strategy.py:1840-1850` (adoption embed in `_discover_wheel_state`)
- Modify: `wheel_strategy.py:2261-2274` (opened embed in `_auto_open_spread`)
- Test: `tests/test_auto_spread.py` (append `test_spread_embed_fields`)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_auto_spread.py`:

```python
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest tests/test_auto_spread.py::test_spread_embed_fields -q`
Expected: FAIL — `AttributeError: module 'wheel_strategy' has no attribute '_spread_embed_fields'`.

- [ ] **Step 3: Add the helper**

Insert directly above `def _open_spread_mleg(` (currently `wheel_strategy.py:1997`):

```python
def _spread_embed_fields(short_strike: float, long_strike: float,
                         width: float, net_credit: float, max_loss: float,
                         expiration: str) -> list[dict]:
    """Build the structured Discord embed fields for a put credit spread.

    Pure (no I/O) so it is unit-testable. `expiration` is an ISO
    'YYYY-MM-DD' string; DTE is computed against today.
    """
    from datetime import date
    try:
        dte = (date.fromisoformat(expiration) - date.today()).days
    except ValueError:
        dte = 0
    return [
        {"name": "Short put",  "value": f"${short_strike:.2f}", "inline": True},
        {"name": "Long put",   "value": f"${long_strike:.2f}",  "inline": True},
        {"name": "Width",      "value": f"${width:.2f}",        "inline": True},
        {"name": "Net credit",
         "value": f"${net_credit:.2f}/sh\n(${net_credit * 100:.2f})",
         "inline": True},
        {"name": "Max loss",
         "value": f"${max_loss:.2f}/sh\n(${max_loss * 100:.2f})",
         "inline": True},
        {"name": "Expires",
         "value": f"{expiration}\n({dte}d)",
         "inline": True},
    ]
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `python -m pytest tests/test_auto_spread.py::test_spread_embed_fields -q`
Expected: PASS.

- [ ] **Step 5: Reformat the opened embed**

Replace `wheel_strategy.py:2261-2274` (the `send_embed(TRADES_CH, f"Auto-spread: opened put credit spread {sym}", ...)` call, the whole call through its closing `)`) with:

```python
        send_embed(
            TRADES_CH, f"🎯 Put credit spread opened — {sym}",
            color=Color.GREEN,
            description=f"Screener-driven · wheelability {norm[sym]:.0f}",
            fields=_spread_embed_fields(
                short_strike, chosen["long_strike"], width,
                net_credit, max_loss, expiration,
            ),
            footer=f"wheel_strategy.py · {MODE} · order {str(order_id)[:8]}…",
            actions_channel=ACTIONS_CH,
        )
```

(`order_id` is assigned just above this call at `wheel_strategy.py:2260`; `expiration` is the string from `short_contract["expiration_date"]`.)

- [ ] **Step 6: Reformat the adoption embed**

Replace `wheel_strategy.py:1840-1850` (the `send_embed(TRADES_CH, f"Wheel: adopted spread {ticker}", ...)` call, the whole call through its closing `)`) with:

```python
            send_embed(
                TRADES_CH, f"📥 Spread adopted — {ticker}",
                color=Color.BLUE,
                description=(
                    f"{sp.spread_type.replace('_', ' ')} · user-opened, "
                    f"now bot-managed ({sp.short_qty}× contracts)"
                ),
                fields=_spread_embed_fields(
                    sp.short_strike, sp.long_strike, sp.width,
                    sp.net_credit, sp.max_loss, sp.expiration.isoformat(),
                ),
                footer=f"wheel_strategy.py · {MODE}",
                actions_channel=ACTIONS_CH,
            )
```

(`sp.expiration` is a `date` — `.isoformat()` yields the 'YYYY-MM-DD' string the helper expects. `sp.width`, `sp.net_credit`, `sp.max_loss`, `sp.short_qty` already exist on `SpreadPair`, per `_adopt_spread` at `wheel_strategy.py:1790-1806`.)

- [ ] **Step 7: Run the full suite**

Run: `python -m pytest tests/ -q`
Expected: PASS. Existing tests that assert the adoption/open embed *fired* (e.g. checking `send_embed` was called) still pass — only `title`/`description`/`fields` changed, not whether it's sent. If a test asserts on the old description substring (search `tests/` for `"opened put credit spread"` or `"adopted spread"`), update that assertion to match the new title/description; do not revert production code.

- [ ] **Step 8: Commit**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "feat: structured-field Discord cards for spread open + adoption"
```

---

## Task 5: Final validation

- [ ] **Step 1: Full suite green**

Run: `python -m pytest tests/ -q`
Expected: PASS, no errors. Note the pre-existing `datetime.utcnow()` DeprecationWarnings are unrelated and acceptable.

- [ ] **Step 2: Sanity-check the universe count**

Run: `python -c "import screener_core as s; u=s.DEFAULT_CONSERVATIVE_UNIVERSE; print(len(u), 'names'); print('dupes:', len(u)!=len(set(u)))"`
Expected: prints a count in [105, 130] and `dupes: False`.

- [ ] **Step 3: Ship + live-verify (requires user confirmation — affects live bots)**

Pushing to `main` makes the next SM cron cycle pick this up. Per the spec validation plan, after push confirm on the next sm500/sm1000/sm2000 runs:
- sm500 `candidates_considered` jumps from ~8 to ~30+
- an sm500 spread opens when a $1-wide net-of-credit fits 20%
- sm1000/sm2000 still trade; the new embed renders cleanly in `#sm{n}-trades`
- no Alpaca 429s / step-time blowup from the larger universe (watch `#sm*-errors` + run logs)

Do not push to `main` without explicit user confirmation (this session's established pattern: small flagged changes go direct to `main`, but the user decides per change).

---

## Self-Review

**Spec coverage:** Part A → Task 1. Part B1 (sm500 0.20) → Task 2. Part B2 (net-of-credit gate + loop reorder) → Task 3. Part B3 (tests) → Tasks 2 & 3. Part C (embed helper + both embeds + test) → Task 4. Validation plan → Task 5. All spec sections covered.

**Placeholder scan:** No TBD/TODO. Every code step shows full replacement code and exact line ranges. Test code is complete and runnable.

**Type consistency:** `spread_passes_risk(width, net_credit, equity, max_risk_pct)` defined in Task 3 Step 3, called with that exact 4-arg order in Task 3 Step 4 and tested with it in Task 3 Step 1. `_spread_embed_fields(short_strike, long_strike, width, net_credit, max_loss, expiration)` defined in Task 4 Step 3, called with that signature in Task 4 Steps 5–6, tested in Step 1. `chosen` dict keys (`long_occ`, `long_strike`, `long_mid`, `width`) unchanged from the original loop, consumed unchanged after the loop. Embed field schema `{"name","value","inline"}` matches `send_embed`'s documented `fields` contract.
