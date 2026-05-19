# SM Put-Credit-Spread Engine — Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the SM (sm500/sm1000/sm2000) auto-spread engine from reliably negative expectancy to reliably positive by adding a credit-to-width floor, swapping to best-ratio width selection, replacing the cycle-gated 50%-of-max-loss stop with an early-firing 2×-credit stop + underlying-price tripwire, and adding a curated quality universe with a 20-day SMA trend filter.

**Architecture:** All changes live in three existing files (`config.py`, `wheel_strategy.py`, `screener_core.py`) plus tests. SM modes get new param keys; conservative/aggressive/manual/live read those keys with safe fallbacks so they remain byte-unaffected. The cutover (Task 0) is gating — manual Alpaca/secret work plus repo-side state-file deletion must complete before any code change ships.

**Tech Stack:** Python 3.11, pytest, Alpaca paper API (mocked in tests), yfinance (mocked).

**Spec:** [docs/superpowers/specs/2026-05-19-sm-pcs-hardening-design.md](../specs/2026-05-19-sm-pcs-hardening-design.md)

## File Structure

**Modified:**
- `config.py` — sm500/sm1000/sm2000 mode blocks: add `min_credit_to_width_pct`, `trend_filter`, `screener_universe`, `spread_stop_credit_mult`; tighten `max_risk_pct_equity` and `max_concurrent_spreads`. Other modes untouched.
- `wheel_strategy.py` — module-level config reads (~141-146): add `SPREAD_STOP_CREDIT_MULT`. `handle_spread` (~576+): replace stop branch + add underlying tripwire. `_auto_open_spread` (~2359+): add credit-to-width gate, switch to best-ratio width selection, add trend-filter gate.
- `screener_core.py` — add `SM_CURATED_UNIVERSE` constant and `is_above_sma20()` pure helper with injected price-history fetcher.
- `CLAUDE.md` — update SM auto-spread section + posture table.

**Modified (tests):**
- `tests/test_auto_spread.py` — credit-to-width gate, best-ratio width selection, trend-filter gate.
- `tests/test_spread_management.py` — 2× credit stop, underlying-price tripwire.
- `tests/test_modes_sm.py` — posture-split params + non-SM-mode byte-affected guard.
- `tests/test_screener_core.py` (extend if exists, else create) — SM_CURATED_UNIVERSE membership; `is_above_sma20` pure logic.

**Deleted (cutover):**
- `wheel_state_sm500.json`, `wheel_state_sm1000.json`, `wheel_state_sm2000.json`
- `strategy_state_sm500.json`, `strategy_state_sm1000.json`, `strategy_state_sm2000.json` (if present)

---

## Task 0: Cutover (T0 prep) — GATING

**Files:**
- Delete: `wheel_state_sm500.json`, `wheel_state_sm1000.json`, `wheel_state_sm2000.json`, `strategy_state_sm500.json`, `strategy_state_sm1000.json`, `strategy_state_sm2000.json` (any that exist on `main`)

**Manual prerequisites (Tim performs — verify before proceeding):**

- [ ] **Step 1: Cancel all open SM spreads** via the Alpaca paper web UI on each SM sub-account. Confirm via Alpaca dashboard that each sub-account has zero open positions and zero open orders.

- [ ] **Step 2: Reset each SM paper sub-account to its seed balance** — sm500 → $500, sm1000 → $1,000, sm2000 → $2,000. (Alpaca's "Reset" resets to $100k; either reset then withdraw, or delete and recreate the sub-account.)

- [ ] **Step 3: Generate new API keys** for each reset sub-account.

- [ ] **Step 4: Update 9 GitHub Actions secrets** at https://github.com/tsronco/TradingBotTest-Claude/settings/secrets/actions — `ALPACA_SM500_API_KEY`, `ALPACA_SM500_API_SECRET`, `ALPACA_SM500_BASE_URL`, and the matching `SM1000`/`SM2000` triples.

- [ ] **Step 5: Update 9 Vercel env vars** on the `tradingbot-dashboard` project — same names as step 4. Use `npx vercel env add <NAME> production` from `dashboard/` or the Vercel web UI.

- [ ] **Step 6: Update local `.env`** to match (so any local script invocations also point at the new accounts).

**Repo-side (one commit):**

- [ ] **Step 7: Delete SM state files on the active branch.**

Run from repo root:

```bash
git rm -f wheel_state_sm500.json wheel_state_sm1000.json wheel_state_sm2000.json 2>/dev/null || true
git rm -f strategy_state_sm500.json strategy_state_sm1000.json strategy_state_sm2000.json 2>/dev/null || true
git status
```

Expected: 3–6 deletions staged depending on which `strategy_state_sm{n}.json` files exist (`wheel_state_sm{n}.json` will definitely exist).

- [ ] **Step 8: Commit the deletions.**

```bash
git commit -m "$(cat <<'EOF'
cutover: wipe SM state files for hardened-engine T0

Tim's reset the three SM Alpaca paper sub-accounts to seed balances
($500/$1k/$2k) and rotated API keys. Deleting the bot's stored state
so the hardened engine starts with no inherited spread_active or
strategy entries on its first cycle. That first cycle's equity is T0
for the 2-week validation window.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Verify all three SM accounts read seed equity.**

After steps 1–8 land on `main` and the next scheduled SM cron fires (or manually trigger via `gh workflow run tsla-monitor-sm500.yml`), check `#sm500-actions` / `#sm1000-actions` / `#sm2000-actions` Discord channels for a heartbeat log line showing `equity ~= 500.00` / `1000.00` / `2000.00`. If equity reads wrong, the secrets are pointing at the wrong sub-account — STOP and fix before proceeding.

---

## Task 1: Curated SM universe in `screener_core.py`

**Files:**
- Modify: `screener_core.py` (add new module-level constant after `DEFAULT_CONSERVATIVE_UNIVERSE` ends at line ~60)
- Test: `tests/test_screener_core.py` (create if missing — search first with `ls tests/ | grep screener_core`)

**Selection criteria** (spec section 4 — "Quality + trend filter"): liquid weeklies/monthlies, tight option spreads, IV high enough that ~10% OTM puts clear the 0.33 credit-to-width floor at 14–28 DTE. Drawn from names already validated on conservative/aggressive accounts plus a few mid-IV growth names. Excludes the cheap-junk tier (NCLH, HPQ, KSS, RIVN, M, etc.) that the current sm500 `max_underlying_price: 25` filter selects into.

- [ ] **Step 1: Write the failing test.** Add to `tests/test_screener_core.py`:

```python
import screener_core

def test_sm_curated_universe_excludes_junk_tier():
    """The new SM list must NOT contain the cheap-junk names that the
    old sm500 max_underlying_price:25 filter was selecting into."""
    junk = {"NCLH", "HPQ", "KSS", "RIVN", "M", "NIO", "AAL", "WBD", "PARA"}
    assert junk.isdisjoint(set(screener_core.SM_CURATED_UNIVERSE))


def test_sm_curated_universe_is_subset_of_quality_names():
    """Spot-check: every SM name appears in the larger conservative
    universe (no surprise picks)."""
    assert set(screener_core.SM_CURATED_UNIVERSE).issubset(
        set(screener_core.DEFAULT_CONSERVATIVE_UNIVERSE)
    )


def test_sm_curated_universe_size():
    """Tight list — under 20 names so the screener's scoring loop
    doesn't waste API calls on borderline tickers."""
    assert 8 <= len(screener_core.SM_CURATED_UNIVERSE) <= 18
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `python -m pytest tests/test_screener_core.py::test_sm_curated_universe_excludes_junk_tier -v`
Expected: FAIL with `AttributeError: module 'screener_core' has no attribute 'SM_CURATED_UNIVERSE'`.

- [ ] **Step 3: Add the constant.** In `screener_core.py`, immediately after the `DEFAULT_CONSERVATIVE_UNIVERSE` closing `})` (around line 60):

```python


# ── SM-mode curated universe ─────────────────────────────────────────────
# Hand-picked for the hardened SM auto-spread engine (2026-05-19). Criteria:
#   - liquid options (weeklies or active monthlies)
#   - tight bid/ask spreads on near-the-money puts
#   - IV high enough that ~10% OTM puts at 14-28 DTE can clear the
#     min_credit_to_width_pct floor (0.33 Balanced / 0.40 Conservative)
#   - quality enough that an assignment wouldn't be a disaster (though
#     SM modes never accept assignment — spread is defined-risk)
#
# Deliberately EXCLUDES the ≤$25 junk tier the old sm500 filter selected
# (NCLH, HPQ, KSS, RIVN, M, NIO, AAL, etc.) — those names were the source
# of the −$280 / −8% bleed over 2026-05-18 to 2026-05-19.
SM_CURATED_UNIVERSE: list[str] = sorted({
    # Higher-IV growth / semis (Balanced posture credit floor target)
    "AMD", "NVDA", "MU", "PLTR",
    # Mid-IV financials / consumer (proven on conservative wheel)
    "BAC", "SOFI", "F", "T", "INTC", "PFE", "KO", "XOM",
})
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `python -m pytest tests/test_screener_core.py -v -k sm_curated`
Expected: 3 PASS.

- [ ] **Step 5: Commit.**

```bash
git add screener_core.py tests/test_screener_core.py
git commit -m "$(cat <<'EOF'
screener_core: add SM_CURATED_UNIVERSE for hardened SM engine

12 names hand-picked for the SM auto-spread engine: quality enough that
the new 0.33/0.40 credit-to-width floor is reachable at ~10% OTM and
14-28 DTE, but excluding the cheap-junk tier (NCLH, HPQ, KSS, RIVN, M)
that drove the 2026-05-18/19 losses on the old sm500 ≤$25 filter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SMA20 trend helper in `screener_core.py`

**Files:**
- Modify: `screener_core.py` (add helper near the other network helpers ~line 100)
- Test: `tests/test_screener_core.py`

The helper is **pure-with-injection**: the price-history fetch is a callable parameter so the unit test mocks the data, no network. Production wires Alpaca's `/v2/stocks/{symbol}/bars` via the existing `api_get` pattern used by `score_candidate`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_screener_core.py`:

```python
def test_is_above_sma20_returns_true_when_price_above_average():
    # 20 closes averaging 10.00; current price 11.00 → above SMA → True
    closes = [10.0] * 20
    fetch = lambda sym: closes
    assert screener_core.is_above_sma20("ANY", 11.0, fetch) is True


def test_is_above_sma20_returns_false_when_price_below_average():
    closes = [10.0] * 20
    fetch = lambda sym: closes
    assert screener_core.is_above_sma20("ANY", 9.0, fetch) is False


def test_is_above_sma20_boundary_inclusive():
    # price exactly == SMA20 counts as above (don't reject borderline)
    closes = [10.0] * 20
    fetch = lambda sym: closes
    assert screener_core.is_above_sma20("ANY", 10.0, fetch) is True


def test_is_above_sma20_insufficient_history_returns_false():
    # No 20 days of data → conservative fail-closed: treat as below
    # (don't sell puts on a symbol we can't verify the trend on)
    fetch = lambda sym: [10.0] * 5
    assert screener_core.is_above_sma20("ANY", 11.0, fetch) is False


def test_is_above_sma20_fetch_returns_none_is_false():
    fetch = lambda sym: None
    assert screener_core.is_above_sma20("ANY", 11.0, fetch) is False


def test_is_above_sma20_fetch_raises_is_false():
    def boom(sym):
        raise RuntimeError("network down")
    assert screener_core.is_above_sma20("ANY", 11.0, boom) is False
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `python -m pytest tests/test_screener_core.py -v -k is_above_sma20`
Expected: 6 FAIL with `AttributeError: module 'screener_core' has no attribute 'is_above_sma20'`.

- [ ] **Step 3: Implement the helper.** Add to `screener_core.py` near the other network helpers (after `_get_latest_price`, around line 120):

```python


def is_above_sma20(
    symbol: str,
    current_price: float,
    fetch_closes,
) -> bool:
    """Return True iff current_price >= mean of last 20 daily closes.

    Used as the trend gate on the SM auto-spread engine: we only open
    a put credit spread when the underlying is at or above its 20-day
    SMA (i.e., not in a short-term downtrend).

    Fail-closed posture: any failure to obtain 20 valid closes returns
    False. Selling puts on a symbol whose trend we cannot verify is
    the exact failure mode this gate exists to prevent.

    Parameters
    ----------
    symbol         For logging context only — does not affect the math.
    current_price  Latest stock price (caller already has this from
                   score_candidate's `r["price"]`; passing it in avoids
                   a redundant API call).
    fetch_closes   Callable(symbol) -> list[float] | None. The 20 most
                   recent daily closes (oldest first or newest first —
                   order does not affect the mean). Injected so tests
                   stay pure-Python.
    """
    try:
        closes = fetch_closes(symbol)
    except Exception:
        return False
    if not closes or len(closes) < 20:
        return False
    sma20 = sum(closes[-20:]) / 20.0
    return current_price >= sma20
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `python -m pytest tests/test_screener_core.py -v -k is_above_sma20`
Expected: 6 PASS.

- [ ] **Step 5: Commit.**

```bash
git add screener_core.py tests/test_screener_core.py
git commit -m "$(cat <<'EOF'
screener_core: add is_above_sma20 trend-filter helper

Pure-with-injection so tests stay network-free. Fail-closed: any error
or short history returns False — we will not sell puts on a symbol
whose trend we cannot verify. Wired into _auto_open_spread in a later
task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Production wiring for SMA20 — Alpaca bar fetcher

**Files:**
- Modify: `wheel_strategy.py` (add a thin fetcher near the other Alpaca helpers ~line 862 next to `get_latest_price`)
- Test: `tests/test_auto_spread.py` (extend)

The unit test for `is_above_sma20` already covers the pure logic. This task adds the production fetcher (Alpaca bars API) and tests it with the standard `monkeypatch.setattr(ws, "_alpaca_request", ...)` pattern.

- [ ] **Step 1: Write the failing test.** Append to `tests/test_auto_spread.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `python -m pytest tests/test_auto_spread.py -v -k get_recent_daily_closes`
Expected: 3 FAIL with `AttributeError: ... no attribute 'get_recent_daily_closes'`.

- [ ] **Step 3: Implement the fetcher.** In `wheel_strategy.py`, add immediately after `get_latest_price` (around line 945):

```python


def get_recent_daily_closes(symbol: str, n: int = 20) -> list:
    """Return the last `n` daily close prices for `symbol`, oldest first.

    Returns [] on any failure (HTTP error, bad payload, exception).
    Used by the SM auto-spread engine's trend gate; callers expect
    empty-list-means-don't-trade.
    """
    try:
        from datetime import date, timedelta
        end = date.today()
        start = end - timedelta(days=n * 2 + 7)  # weekends + holiday cushion
        url = (
            f"https://data.alpaca.markets/v2/stocks/{symbol}/bars"
            f"?timeframe=1Day&start={start.isoformat()}&end={end.isoformat()}"
            f"&limit={n + 10}&feed=iex&adjustment=raw"
        )
        resp = _alpaca_request("GET", url, headers=HEADERS, timeout=10)
        if resp.status_code != 200:
            return []
        bars = resp.json().get("bars") or []
        closes = [float(b["c"]) for b in bars if "c" in b]
        return closes[-n:]
    except Exception:
        return []
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `python -m pytest tests/test_auto_spread.py -v -k get_recent_daily_closes`
Expected: 3 PASS.

- [ ] **Step 5: Commit.**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "$(cat <<'EOF'
wheel_strategy: add get_recent_daily_closes (Alpaca bars fetcher)

Production wiring for screener_core.is_above_sma20. Returns [] on any
failure so the trend gate fail-closes (skips the symbol).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Config — Balanced posture (sm1000, sm2000)

**Files:**
- Modify: `config.py` (sm1000 block at ~line 436, sm2000 block at ~line 491)
- Test: `tests/test_modes_sm.py`

Adds the new keys, tightens existing risk caps. Per spec section 5: `min_credit_to_width_pct=0.33`, `trend_filter=True`, `screener_universe=SM_CURATED_UNIVERSE`, `spread_stop_credit_mult=2.0`, `max_risk_pct_equity=0.10` (down from 0.15), `max_concurrent_spreads`: sm1000→2, sm2000→3 (sm1000 was 3, sm2000 stays 3).

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_modes_sm.py`:

```python
def test_sm1000_balanced_posture_params():
    import config
    cfg = config.MODES["sm1000"]
    assert cfg["min_credit_to_width_pct"] == 0.33
    assert cfg["trend_filter"] is True
    assert cfg["spread_stop_credit_mult"] == 2.0
    assert cfg["max_risk_pct_equity"] == 0.10
    assert cfg["max_concurrent_spreads"] == 2
    # universe pointer — verified against the actual list elsewhere
    from screener_core import SM_CURATED_UNIVERSE
    assert cfg["screener_universe"] == SM_CURATED_UNIVERSE


def test_sm2000_balanced_posture_params():
    import config
    cfg = config.MODES["sm2000"]
    assert cfg["min_credit_to_width_pct"] == 0.33
    assert cfg["trend_filter"] is True
    assert cfg["spread_stop_credit_mult"] == 2.0
    assert cfg["max_risk_pct_equity"] == 0.10
    assert cfg["max_concurrent_spreads"] == 3
    from screener_core import SM_CURATED_UNIVERSE
    assert cfg["screener_universe"] == SM_CURATED_UNIVERSE
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `python -m pytest tests/test_modes_sm.py -v -k "sm1000_balanced or sm2000_balanced"`
Expected: 2 FAIL — `KeyError: 'min_credit_to_width_pct'` (or equivalent on `trend_filter`).

- [ ] **Step 3: Update the sm1000 block** in `config.py`. Locate the auto-open block (around line 436–449) and apply these edits:

Replace existing:
```python
        "max_risk_pct_equity":       0.15,
```
with:
```python
        "max_risk_pct_equity":       0.10,
```

Replace existing:
```python
        "max_concurrent_spreads":    3,
```
with:
```python
        "max_concurrent_spreads":    2,
```

Add these new keys inside the same dict literal (immediately after `max_underlying_price`):

```python
        # ── Hardened-engine additions (2026-05-19) ───────────────────────
        "min_credit_to_width_pct":   0.33,    # net_credit >= width * this
        "spread_stop_credit_mult":   2.0,     # close at 2x credit (vs 50% max loss)
        "trend_filter":              True,    # require price >= 20-day SMA
        "screener_universe":         None,    # set programmatically below — keep None
```

Then **at the bottom of `config.py` (after the `MODES = {...}` literal closes)**, add:

```python
# ── Late binding for SM_CURATED_UNIVERSE ─────────────────────────────────
# screener_core imports config in some paths; we set the universe pointer
# after MODES is built to keep the import graph one-directional.
from screener_core import SM_CURATED_UNIVERSE as _SM_CURATED_UNIVERSE
MODES["sm1000"]["screener_universe"] = _SM_CURATED_UNIVERSE
MODES["sm2000"]["screener_universe"] = _SM_CURATED_UNIVERSE
# sm500 set in Task 5 (Conservative posture).
```

- [ ] **Step 4: Update the sm2000 block** in `config.py` (around line 491–504), same edits as sm1000 EXCEPT keep `max_concurrent_spreads: 3`:

Replace existing:
```python
        "max_risk_pct_equity":       0.15,
```
with:
```python
        "max_risk_pct_equity":       0.10,
```

`max_concurrent_spreads` stays `3`. Add the same four new keys inside the sm2000 dict literal:

```python
        # ── Hardened-engine additions (2026-05-19) ───────────────────────
        "min_credit_to_width_pct":   0.33,
        "spread_stop_credit_mult":   2.0,
        "trend_filter":              True,
        "screener_universe":         None,
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `python -m pytest tests/test_modes_sm.py -v -k "sm1000_balanced or sm2000_balanced"`
Expected: 2 PASS.

- [ ] **Step 6: Commit.**

```bash
git add config.py tests/test_modes_sm.py
git commit -m "$(cat <<'EOF'
config: sm1000/sm2000 Balanced posture — hardened-engine params

Adds min_credit_to_width_pct=0.33, spread_stop_credit_mult=2.0,
trend_filter=True, and pins screener_universe to SM_CURATED_UNIVERSE.
Tightens max_risk_pct_equity 0.15 -> 0.10. sm1000 max_concurrent
3 -> 2; sm2000 stays 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Config — Conservative posture (sm500)

**Files:**
- Modify: `config.py` (sm500 block at ~line 377)
- Test: `tests/test_modes_sm.py`

Conservative posture per spec section 5: stricter credit floor (0.40), same tighter risk cap (0.10), concurrent down to 1, same trend filter on, same stop multiplier. Keep `max_underlying_price` (the cheap-tier filter) — combined with the new credit floor this means sm500 will frequently no-trade, which is the *correct* behavior (logged as `auto_spread_no_trade`, not an error).

- [ ] **Step 1: Write the failing test.** Append to `tests/test_modes_sm.py`:

```python
def test_sm500_conservative_posture_params():
    import config
    cfg = config.MODES["sm500"]
    assert cfg["min_credit_to_width_pct"] == 0.40   # stricter than balanced
    assert cfg["trend_filter"] is True
    assert cfg["spread_stop_credit_mult"] == 2.0
    assert cfg["max_risk_pct_equity"] == 0.10
    assert cfg["max_concurrent_spreads"] == 1
    assert cfg["max_underlying_price"] == 25         # retained intentionally
    from screener_core import SM_CURATED_UNIVERSE
    assert cfg["screener_universe"] == SM_CURATED_UNIVERSE
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `python -m pytest tests/test_modes_sm.py -v -k sm500_conservative`
Expected: FAIL — `KeyError: 'min_credit_to_width_pct'`.

- [ ] **Step 3: Update the sm500 block** in `config.py` (around line 377–395):

Replace existing:
```python
        "max_risk_pct_equity":       0.20,    # max loss / equity ≤ 20% (sm500 only — fits a $1-wide spread)
```
with:
```python
        "max_risk_pct_equity":       0.10,    # hardened 2026-05-19: 0.20 -> 0.10
```

Replace existing:
```python
        "max_concurrent_spreads":    3,
```
with:
```python
        "max_concurrent_spreads":    1,       # Conservative: at most 1 open
```

Add the new keys immediately after `max_underlying_price` (which stays):
```python
        # ── Hardened-engine additions (2026-05-19, Conservative posture) ─
        "min_credit_to_width_pct":   0.40,    # stricter than sm1000/sm2000
        "spread_stop_credit_mult":   2.0,
        "trend_filter":              True,
        "screener_universe":         None,    # set in the late-binding block
```

And update the late-binding block at the bottom of `config.py`:

```python
MODES["sm500"]["screener_universe"] = _SM_CURATED_UNIVERSE
MODES["sm1000"]["screener_universe"] = _SM_CURATED_UNIVERSE
MODES["sm2000"]["screener_universe"] = _SM_CURATED_UNIVERSE
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `python -m pytest tests/test_modes_sm.py -v -k sm500_conservative`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add config.py tests/test_modes_sm.py
git commit -m "$(cat <<'EOF'
config: sm500 Conservative posture — stricter than Balanced

min_credit_to_width_pct=0.40 (vs 0.33 Balanced). max_risk_pct_equity
0.20 -> 0.10. max_concurrent 3 -> 1. max_underlying_price=25 retained
intentionally — combined with the new credit floor, sm500 is expected
to frequently no-trade and that is correct behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Module-level read of `spread_stop_credit_mult`

**Files:**
- Modify: `wheel_strategy.py` (the `apply_mode` function around line 141–146)

Adds the new module-level constant alongside the existing `SPREAD_*` constants, with default `None` so non-SM modes fall through to the existing `SPREAD_STOP_LOSS_PCT` behavior unchanged.

- [ ] **Step 1: Write the failing test.** Append to `tests/test_modes_sm.py`:

```python
def test_apply_mode_reads_spread_stop_credit_mult_for_sm_modes():
    import wheel_strategy as ws
    import config
    ws.apply_mode("sm1000", config.MODES["sm1000"])
    assert ws.SPREAD_STOP_CREDIT_MULT == 2.0


def test_apply_mode_spread_stop_credit_mult_none_for_non_sm_modes():
    import wheel_strategy as ws
    import config
    ws.apply_mode("conservative", config.MODES["conservative"])
    assert ws.SPREAD_STOP_CREDIT_MULT is None
    ws.apply_mode("aggressive", config.MODES["aggressive"])
    assert ws.SPREAD_STOP_CREDIT_MULT is None
    ws.apply_mode("manual", config.MODES["manual"])
    assert ws.SPREAD_STOP_CREDIT_MULT is None
    ws.apply_mode("live", config.MODES["live"])
    assert ws.SPREAD_STOP_CREDIT_MULT is None
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `python -m pytest tests/test_modes_sm.py -v -k apply_mode_reads_spread_stop_credit_mult`
Expected: FAIL — `AttributeError: module 'wheel_strategy' has no attribute 'SPREAD_STOP_CREDIT_MULT'`.

- [ ] **Step 3: Update `apply_mode`** in `wheel_strategy.py` (around line 141–146). Replace:

```python
    SPREAD_MANAGEMENT      = cfg.get("spread_management", False)
    SPREAD_EARLY_CLOSE_PCT = cfg.get("spread_early_close_pct", 0.50)
    SPREAD_STOP_LOSS_PCT   = cfg.get("spread_stop_loss_pct", 0.50)
    SPREAD_DTE_FLOOR       = cfg.get("spread_dte_floor", 2)
```

with:

```python
    SPREAD_MANAGEMENT       = cfg.get("spread_management", False)
    SPREAD_EARLY_CLOSE_PCT  = cfg.get("spread_early_close_pct", 0.50)
    SPREAD_STOP_LOSS_PCT    = cfg.get("spread_stop_loss_pct", 0.50)
    SPREAD_DTE_FLOOR        = cfg.get("spread_dte_floor", 2)
    # Hardened-engine: when set (SM modes only), replaces SPREAD_STOP_LOSS_PCT
    # as the stop trigger in handle_spread. None for cons/agg/manual/live —
    # those modes keep the old 50%-of-max-loss behavior unchanged.
    SPREAD_STOP_CREDIT_MULT = cfg.get("spread_stop_credit_mult", None)
```

Also add `SPREAD_STOP_CREDIT_MULT` to the module's `global` statement at the top of `apply_mode`. Find the existing `global` line in `apply_mode` (search file for `def apply_mode` then look at the first few lines of the function body) and append `SPREAD_STOP_CREDIT_MULT` to its comma-separated list. If no such `global` exists, the assignment above already creates the module-level name on first call.

Also initialize the module-level constant at file scope so importers reading it before `apply_mode()` is called don't crash. Find the existing module-level `SPREAD_STOP_LOSS_PCT = ...` initializer (around line 150–160, in the "Initialize at import time to conservative defaults" block) and add right next to it:

```python
SPREAD_STOP_CREDIT_MULT: float | None = None
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `python -m pytest tests/test_modes_sm.py -v -k apply_mode_reads_spread_stop_credit_mult`
Expected: 2 PASS.

- [ ] **Step 5: Run the full mode-isolation test suite as a regression check.**

Run: `python -m pytest tests/test_modes_sm.py -v`
Expected: ALL PASS (including the existing isolation tests — proves cons/agg/manual/live still build cleanly).

- [ ] **Step 6: Commit.**

```bash
git add wheel_strategy.py tests/test_modes_sm.py
git commit -m "$(cat <<'EOF'
wheel_strategy: SPREAD_STOP_CREDIT_MULT module-level constant

Read from cfg in apply_mode, default None. None means non-SM modes
fall through to SPREAD_STOP_LOSS_PCT unchanged. Wired into the actual
stop trigger in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `handle_spread` — 2× credit stop trigger

**Files:**
- Modify: `wheel_strategy.py` (`handle_spread`, the stop branch around line 727–732)
- Test: `tests/test_spread_management.py`

Replaces the stop branch logic. When `SPREAD_STOP_CREDIT_MULT` is set (SM modes), the stop fires when `close_cost >= net_credit * SPREAD_STOP_CREDIT_MULT`. When `None` (cons/agg/manual/live), fall through to the existing 50%-of-max-loss behavior unchanged.

- [ ] **Step 1: Read existing test scaffolding** so the new tests match the file's fixtures.

Run: `python -m pytest tests/test_spread_management.py --collect-only -q | head -30`

If the file uses a common fixture (state dict, mocked positions, mocked quotes), copy that pattern. The Step-3 test below assumes the standard `monkeypatch.setattr(ws, "get_positions", ...)` / `get_option_quote` mock pattern from the existing file; adjust to match the actual fixtures if different.

- [ ] **Step 2: Write the failing tests.** Append to `tests/test_spread_management.py`:

```python
def _seeded_sm_spread_state():
    """Minimal state dict for an active sm1000 spread.

    short P14 @ 0.30 credit (gross), long P13 @ 0.10 → net_credit 0.20,
    width 1.00, max_loss 0.80. Stop at 2x credit = close_cost >= 0.40."""
    return {
        "_meta": {},
        "AMD": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "expiration": "2099-12-31",   # far future — DTE branch can't fire
            "net_credit": 0.20,
            "max_loss": 0.80,
            "width": 1.0,
            "short_leg": {"occ": "AMD2099P00014000", "strike": 14.0, "premium": 0.30},
            "long_leg":  {"occ": "AMD2099P00013000", "strike": 13.0, "premium": 0.10},
            "open_order_id": None,
        },
    }


def test_handle_spread_sm_stop_fires_at_2x_credit(monkeypatch):
    import wheel_strategy as ws
    import config
    ws.apply_mode("sm1000", config.MODES["sm1000"])  # arms SPREAD_STOP_CREDIT_MULT=2.0

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    # close_cost = short_ask - long_bid = 0.50 - 0.05 = 0.45 → >= 0.20*2.0 → STOP
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.45, "ask": 0.50},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 15.0)  # above short strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert closed["hit"] == ("AMD", "stop_loss_2x_credit")


def test_handle_spread_sm_stop_does_not_fire_below_2x_credit(monkeypatch):
    import wheel_strategy as ws
    import config
    ws.apply_mode("sm1000", config.MODES["sm1000"])

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    # close_cost = 0.30 - 0.05 = 0.25 → < 0.40 → no stop
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 15.0)

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed


def test_handle_spread_non_sm_mode_still_uses_50pct_max_loss(monkeypatch):
    """Manual mode (spread_management on, spread_stop_credit_mult None)
    must keep the legacy 50%-of-max-loss behavior — byte-unaffected."""
    import wheel_strategy as ws
    import config
    ws.apply_mode("manual", config.MODES["manual"])
    assert ws.SPREAD_STOP_CREDIT_MULT is None  # sanity

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    # close_cost = 0.45 → loss_per_share = 0.45-0.20 = 0.25 < 0.80*0.50 = 0.40 → no stop
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.45, "ask": 0.50},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 15.0)

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed  # manual's 50%-of-max-loss didn't fire either
```

- [ ] **Step 3: Run tests to verify they fail.**

Run: `python -m pytest tests/test_spread_management.py -v -k "handle_spread_sm_stop or handle_spread_non_sm"`
Expected: 3 FAIL — the SM stop test fails because `reason` will be `stop_loss_50pct` (the old behavior fires at close_cost 0.45 vs max_loss*0.50=0.40), not `stop_loss_2x_credit`.

- [ ] **Step 4: Replace the stop branch** in `wheel_strategy.py` `handle_spread`. Find the block at lines 727–732 currently reading:

```python
    # 3. Stop loss trigger
    if pnl["loss_per_share"] >= max_loss * SPREAD_STOP_LOSS_PCT:
        log(f"[{ticker}] spread loss=${pnl['loss_per_share']:.2f} >= "
            f"{SPREAD_STOP_LOSS_PCT:.0%} of max_loss=${max_loss:.2f} — stopping out")
        _close_spread(state, ticker, reason="stop_loss_50pct")
        return
```

Replace with:

```python
    # 3. Stop loss trigger
    # SM modes (SPREAD_STOP_CREDIT_MULT set): fire when buy-back cost
    # reaches N x the credit received — a small, bounded dollar loss that
    # the 10-min cron can actually catch before slippage.
    # Other modes: legacy 50%-of-max-loss behavior, unchanged.
    if SPREAD_STOP_CREDIT_MULT is not None:
        net_credit = float(sym_state["net_credit"])
        stop_price = net_credit * SPREAD_STOP_CREDIT_MULT
        if close_cost >= stop_price:
            log(f"[{ticker}] spread close_cost=${close_cost:.2f} >= "
                f"{SPREAD_STOP_CREDIT_MULT:.1f}x credit ${net_credit:.2f} "
                f"(${stop_price:.2f}) — stopping out")
            _close_spread(state, ticker, reason="stop_loss_2x_credit")
            return
    else:
        if pnl["loss_per_share"] >= max_loss * SPREAD_STOP_LOSS_PCT:
            log(f"[{ticker}] spread loss=${pnl['loss_per_share']:.2f} >= "
                f"{SPREAD_STOP_LOSS_PCT:.0%} of max_loss=${max_loss:.2f} — stopping out")
            _close_spread(state, ticker, reason="stop_loss_50pct")
            return
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `python -m pytest tests/test_spread_management.py -v -k "handle_spread_sm_stop or handle_spread_non_sm"`
Expected: 3 PASS.

- [ ] **Step 6: Run the full spread-management suite as a regression check.**

Run: `python -m pytest tests/test_spread_management.py -v`
Expected: ALL PASS — existing tests cover the legacy 50%-max-loss path (now the `else` branch).

- [ ] **Step 7: Commit.**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "$(cat <<'EOF'
wheel_strategy: handle_spread fires stop at 2x credit on SM modes

When SPREAD_STOP_CREDIT_MULT is set (SM modes only), the stop fires at
close_cost >= net_credit * mult instead of loss >= max_loss * 0.5.
Bounded dollar loss the 10-min cron can actually catch before slip.
Non-SM modes (cons/agg/manual/live) keep the legacy behavior — the
old branch became the else clause, byte-unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `handle_spread` — underlying-price tripwire

**Files:**
- Modify: `wheel_strategy.py` (`handle_spread`, immediately after the profit-trigger branch ~line 725, before the stop trigger)
- Test: `tests/test_spread_management.py`

A second SM-only trigger: if the stock trades through the short strike, close immediately even if the option mid is degenerate. Robust where the 2×-credit stop alone could fail (illiquid chain, crossed quote).

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_spread_management.py`:

```python
def test_handle_spread_sm_underlying_tripwire_put_credit(monkeypatch):
    """Put credit spread: stock trading <= short strike → close immediately."""
    import wheel_strategy as ws
    import config
    ws.apply_mode("sm1000", config.MODES["sm1000"])

    state = _seeded_sm_spread_state()  # short put $14
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    # Quote is fine, 2x stop NOT triggered, but stock crossed short strike.
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 13.95)  # below $14

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert closed["hit"] == ("AMD", "underlying_tripwire")


def test_handle_spread_sm_underlying_tripwire_not_fired_above_strike(monkeypatch):
    import wheel_strategy as ws
    import config
    ws.apply_mode("sm1000", config.MODES["sm1000"])

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 14.05)  # above $14

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed


def test_handle_spread_non_sm_underlying_tripwire_inactive(monkeypatch):
    """Manual mode must NOT get the tripwire — byte-unaffected."""
    import wheel_strategy as ws
    import config
    ws.apply_mode("manual", config.MODES["manual"])

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 13.95)  # below strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed  # manual didn't fire — no tripwire active
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `python -m pytest tests/test_spread_management.py -v -k underlying_tripwire`
Expected: 1 FAIL on the `put_credit` test (tripwire reason not present), 2 PASS by accident on the others. Confirm the FAIL.

- [ ] **Step 3: Add the tripwire** in `wheel_strategy.py` `handle_spread`. After the close_cost computation and BEFORE the profit trigger (i.e., between the `close_cost = ...` block ending around line 715 and the `# 2. Profit trigger` comment around line 720), insert:

```python
    # 2a. Underlying-price tripwire (SM modes only, SPREAD_STOP_CREDIT_MULT set).
    # If the stock has traded through the short strike, close immediately —
    # robust to degenerate/illiquid option quotes where the 2x-credit stop
    # could otherwise miss the trigger by reading a stale mid.
    if SPREAD_STOP_CREDIT_MULT is not None:
        short_strike = float(sym_state["short_leg"]["strike"])
        spread_type = sym_state["spread_type"]
        stock_price = get_latest_price(ticker)
        if stock_price is not None:
            tripped = (
                (spread_type == "put_credit"  and stock_price <= short_strike) or
                (spread_type == "call_credit" and stock_price >= short_strike)
            )
            if tripped:
                log(f"[{ticker}] spread underlying tripwire — stock "
                    f"${stock_price:.2f} crossed short strike "
                    f"${short_strike:.2f} ({spread_type}) — closing")
                _close_spread(state, ticker, reason="underlying_tripwire")
                return
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `python -m pytest tests/test_spread_management.py -v -k underlying_tripwire`
Expected: 3 PASS.

- [ ] **Step 5: Run the full spread-management suite as a regression check.**

Run: `python -m pytest tests/test_spread_management.py -v`
Expected: ALL PASS.

- [ ] **Step 6: Commit.**

```bash
git add wheel_strategy.py tests/test_spread_management.py
git commit -m "$(cat <<'EOF'
wheel_strategy: handle_spread underlying-price tripwire (SM modes)

If the stock crosses the short strike, close immediately — independent
of option quote quality. Only active when SPREAD_STOP_CREDIT_MULT is
set (SM modes). Non-SM modes byte-unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `_auto_open_spread` — credit-to-width gate

**Files:**
- Modify: `wheel_strategy.py` (`_auto_open_spread`, the `min_net_credit` check around line 2553–2557 and the `chosen` selection above it)
- Test: `tests/test_auto_spread.py`

The new ratio gate runs *inside* the width-search loop so a width that fails the ratio is rejected and the loop continues to wider strikes (which can pay proportionally more credit). The existing `min_net_credit` absolute floor stays as the degenerate/negative-credit guard.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_auto_spread.py`:

```python
def test_credit_to_width_gate_accepts_at_or_above_ratio():
    # Pure predicate — extract as a module-level helper for testability.
    import wheel_strategy as ws
    assert ws.credit_ratio_passes(net_credit=0.33, width=1.0, min_ratio=0.33) is True
    assert ws.credit_ratio_passes(net_credit=0.40, width=1.0, min_ratio=0.33) is True
    assert ws.credit_ratio_passes(net_credit=1.50, width=3.0, min_ratio=0.40) is True  # 0.50 ratio


def test_credit_to_width_gate_rejects_below_ratio():
    import wheel_strategy as ws
    assert ws.credit_ratio_passes(net_credit=0.32, width=1.0, min_ratio=0.33) is False
    assert ws.credit_ratio_passes(net_credit=0.10, width=1.0, min_ratio=0.33) is False
    assert ws.credit_ratio_passes(net_credit=0.20, width=1.0, min_ratio=0.40) is False  # Conservative
    # Degenerate width (would div-by-zero) → reject
    assert ws.credit_ratio_passes(net_credit=1.0, width=0.0, min_ratio=0.33) is False
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `python -m pytest tests/test_auto_spread.py -v -k credit_to_width_gate`
Expected: FAIL — `AttributeError: ... no attribute 'credit_ratio_passes'`.

- [ ] **Step 3: Add the predicate** in `wheel_strategy.py` next to the other predicates (after `bp_fits` at line ~2292):

```python


def credit_ratio_passes(net_credit: float, width: float, min_ratio: float) -> bool:
    """Return True iff net_credit / width >= min_ratio.

    Degenerate width (<= 0) is treated as a fail (defensive — width
    should never be <= 0 by the time this is called, but if it ever is
    we won't divide by zero).
    """
    if width <= 0:
        return False
    return (net_credit / width) >= min_ratio
```

- [ ] **Step 4: Wire it into `_auto_open_spread`.** Find the width-search loop block at lines ~2510–2531 (the `for step in range(1, max_steps + 1):` loop). Locate the existing `if not spread_passes_risk(...): continue` check. **Immediately after** the `cand_net_credit = round(short_mid - long_mid, 4)` line, and **before** the `spread_passes_risk` check (so an order is: build candidate → ratio gate → risk gate), insert:

```python
            # Credit-to-width gate (hardened SM engine). Reject thin spreads
            # whose payoff/risk ratio is too asymmetric to ever beat losses.
            min_ratio = cfg.get("min_credit_to_width_pct")
            if min_ratio is not None and not credit_ratio_passes(
                cand_net_credit, width, min_ratio
            ):
                continue
```

The unit test in Step 1 covers the pure predicate. End-to-end behavior (gate firing inside `_auto_open_spread`) is covered by the existing orchestration tests in `test_auto_spread.py` once Task 11's integration test is added.

- [ ] **Step 5: Run tests to verify the predicate passes.**

Run: `python -m pytest tests/test_auto_spread.py -v -k credit_to_width_gate`
Expected: PASS.

- [ ] **Step 6: Run the full auto-spread suite as a regression check.**

Run: `python -m pytest tests/test_auto_spread.py -v`
Expected: ALL PASS (existing orchestration tests use mocked candidates with enough credit; some may need the test fixture's `cfg` to add `min_credit_to_width_pct` — if any pre-existing orchestration test fails because its mocked `cfg` lacks the key, the `cfg.get(... None)` fallback in Step 4 ensures the gate is INACTIVE and skipped, so existing tests pass unchanged).

- [ ] **Step 7: Commit.**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "$(cat <<'EOF'
wheel_strategy: credit-to-width gate in _auto_open_spread

Reject any candidate spread whose net_credit/width < min_credit_to_width_pct.
SM modes set 0.33 (Balanced) / 0.40 (Conservative); other modes leave the
key unset and the gate is skipped — byte-unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `_auto_open_spread` — best-ratio width selection

**Files:**
- Modify: `wheel_strategy.py` (`_auto_open_spread`, the width-search loop around line 2494–2531)
- Test: `tests/test_auto_spread.py`

Switches the loop from "break on first acceptable" to "collect all acceptable widths, then pick the highest credit-to-width ratio." Same risk ceiling, but stops the engine from auto-picking the stingiest spread.

- [ ] **Step 1: Write the failing test.** Append to `tests/test_auto_spread.py`:

```python
def test_pick_best_ratio_width_among_candidates():
    """Given multiple acceptable widths, pick the one with the highest
    credit/width ratio — NOT the narrowest."""
    import wheel_strategy as ws
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
    import wheel_strategy as ws
    assert ws.pick_best_ratio_width([]) is None


def test_pick_best_ratio_width_singleton_returns_it():
    import wheel_strategy as ws
    c = {"width": 1.0, "net_credit": 0.40}
    assert ws.pick_best_ratio_width([c]) is c
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `python -m pytest tests/test_auto_spread.py -v -k pick_best_ratio_width`
Expected: 3 FAIL — `AttributeError: ... no attribute 'pick_best_ratio_width'`.

- [ ] **Step 3: Add the picker.** In `wheel_strategy.py`, next to `credit_ratio_passes` (added in Task 9):

```python


def pick_best_ratio_width(candidates: list) -> dict | None:
    """Pick the candidate with the highest net_credit/width ratio.

    Each candidate is a dict containing at least 'width' and 'net_credit'.
    Returns None on empty input. Stable on ties — first candidate wins
    (which gives the narrowest of equally-good ratios, fine).
    """
    if not candidates:
        return None
    return max(candidates, key=lambda c: c["net_credit"] / c["width"])
```

- [ ] **Step 4: Refactor the width loop** in `_auto_open_spread` to collect candidates then pick best. Replace the existing loop body (lines ~2494–2531) — find the block that starts with `chosen = None` and ends with `break  # first hit == narrowest passing width`. Replace with:

```python
        # Collect every width that clears risk + credit-ratio gates,
        # then pick the one with the highest credit/width payoff.
        candidates = []
        max_steps = 10  # bounded — don't scan an unbounded chain
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
            if not bp_fits(options_bp, width):
                continue
            long_q = get_option_quote(long_contract["symbol"])
            if not long_q:
                continue
            long_mid = (long_q["bid"] + long_q["ask"]) / 2.0
            cand_net_credit = round(short_mid - long_mid, 4)
            # Credit-to-width gate (Task 9)
            min_ratio = cfg.get("min_credit_to_width_pct")
            if min_ratio is not None and not credit_ratio_passes(
                cand_net_credit, width, min_ratio
            ):
                continue
            # Risk-cap gate
            if not spread_passes_risk(width, cand_net_credit, equity,
                                      max_risk_pct):
                continue
            candidates.append({
                "long_occ":    long_contract["symbol"],
                "long_strike": long_strike,
                "long_mid":    long_mid,
                "long_bid":    long_q["bid"],
                "long_ask":    long_q["ask"],
                "width":       width,
                "net_credit":  cand_net_credit,
            })

        chosen = pick_best_ratio_width(candidates)
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `python -m pytest tests/test_auto_spread.py -v -k pick_best_ratio_width`
Expected: 3 PASS.

- [ ] **Step 6: Run the full auto-spread suite as a regression check.**

Run: `python -m pytest tests/test_auto_spread.py -v`
Expected: ALL PASS. Note: existing orchestration tests that mock `find_best_contract` to return a single contract will now produce a 1-element candidate list and `pick_best_ratio_width` returns that single element — same behavior as the old `break` on first hit. No test fixture changes needed.

- [ ] **Step 7: Commit.**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "$(cat <<'EOF'
wheel_strategy: pick best credit/width ratio, not narrowest spread

Old loop broke on the first width clearing the risk cap — which always
selected the stingiest spread. New behavior: collect every acceptable
width, return the highest net_credit/width ratio. Same risk ceiling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `_auto_open_spread` — trend-filter gate

**Files:**
- Modify: `wheel_strategy.py` (`_auto_open_spread`, immediately after the earnings gate around line 2461–2464)
- Test: `tests/test_auto_spread.py`

The trend gate runs per-candidate inside the iterate-best-first loop. If `cfg["trend_filter"]` is True, the candidate must be above its 20-day SMA. Fetches closes via the helper added in Task 3, calls `screener_core.is_above_sma20`.

- [ ] **Step 1: Write the failing test.** Append to `tests/test_auto_spread.py`:

```python
def test_auto_open_spread_skips_symbols_below_sma20(monkeypatch):
    """When trend_filter is True, a candidate below its SMA20 must be
    skipped — even if all other gates pass."""
    import wheel_strategy as ws
    import screener_core
    import config

    ws.apply_mode("sm1000", config.MODES["sm1000"])

    # Minimal state — empty wheel, no open spreads
    state = {"_meta": {}}
    account = {"options_buying_power": 1000, "cash": 1000, "equity": 1000}

    # Mock account fetch + screener: one candidate, score above threshold
    monkeypatch.setattr(ws, "get_account", lambda: account)
    monkeypatch.setattr(screener_core, "build_universe",
        lambda u, a: ["AMD"])
    monkeypatch.setattr(screener_core, "score_candidate",
        lambda *a, **kw: {"score": 9.0, "price": 100.0})
    monkeypatch.setattr(ws, "normalize_scores",
        lambda raw: {"AMD": 99.0})
    # Earnings clean, BP wants spread
    import earnings
    monkeypatch.setattr(earnings, "next_earnings_within", lambda s, d: False)

    # SMA20 helper returns False → below 20-day SMA
    monkeypatch.setattr(ws, "get_recent_daily_closes",
        lambda s, n=20: [110.0] * 20)  # avg 110, current price 100 → below

    # Capture: did _open_spread_mleg get called?
    opened = {"called": False}
    monkeypatch.setattr(ws, "_open_spread_mleg",
        lambda *a, **kw: opened.update(called=True) or "ORDER_ID")

    ws._auto_open_spread(state, account, config.MODES["sm1000"])
    assert opened["called"] is False  # trend gate blocked it


def test_auto_open_spread_proceeds_above_sma20(monkeypatch):
    """Mirror of above — candidate above SMA20 makes it past the trend
    gate. (Other gates may or may not let it through — we only verify the
    trend gate doesn't block in this scenario by checking we get past
    that point. find_best_contract returning None terminates downstream.)"""
    import wheel_strategy as ws
    import screener_core
    import config

    ws.apply_mode("sm1000", config.MODES["sm1000"])
    state = {"_meta": {}}
    account = {"options_buying_power": 1000, "cash": 1000, "equity": 1000}

    monkeypatch.setattr(ws, "get_account", lambda: account)
    monkeypatch.setattr(screener_core, "build_universe", lambda u, a: ["AMD"])
    monkeypatch.setattr(screener_core, "score_candidate",
        lambda *a, **kw: {"score": 9.0, "price": 100.0})
    monkeypatch.setattr(ws, "normalize_scores", lambda raw: {"AMD": 99.0})
    import earnings
    monkeypatch.setattr(earnings, "next_earnings_within", lambda s, d: False)

    # SMA20 returns True → above 20-day SMA → trend gate passes
    monkeypatch.setattr(ws, "get_recent_daily_closes",
        lambda s, n=20: [90.0] * 20)  # avg 90, price 100 → above

    # find_best_contract returns None to terminate downstream cleanly
    monkeypatch.setattr(ws, "find_best_contract", lambda *a, **kw: None)

    trend_check_reached = {"hit": False}
    def spy_is_above(sym, price, fetch):
        trend_check_reached["hit"] = True
        return screener_core.is_above_sma20(sym, price, fetch)
    monkeypatch.setattr(screener_core, "is_above_sma20", spy_is_above)

    ws._auto_open_spread(state, account, config.MODES["sm1000"])
    assert trend_check_reached["hit"] is True
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `python -m pytest tests/test_auto_spread.py -v -k "below_sma20 or proceeds_above_sma20"`
Expected: 2 FAIL — the trend gate isn't wired yet, so the first test's `opened["called"]` will likely be True (or the second's spy never gets hit).

- [ ] **Step 3: Wire the trend gate** in `_auto_open_spread`. Find the earnings gate at lines ~2461–2464:

```python
        if earnings.next_earnings_within(sym, cfg["earnings_exclusion_days"]):
            log(f"[auto-spread] {sym} earnings within "
                f"{cfg['earnings_exclusion_days']}d (or unknown) — skipping")
            continue
```

Immediately AFTER it (and BEFORE the `bp_wants_spread` check), insert:

```python
        # Trend gate (hardened SM engine). Only sell put credit spreads
        # when the underlying is at or above its 20-day SMA — no falling
        # knives. Fail-closed: missing history skips the symbol.
        if cfg.get("trend_filter"):
            price = scored_full[sym]["price"]
            if not screener_core.is_above_sma20(
                sym, price, get_recent_daily_closes
            ):
                log(f"[auto-spread] {sym} below 20-day SMA "
                    f"(price ${price:.2f}) — trend gate skip")
                log_event(LOG_STREAM, "wheel_strategy.py",
                          "auto_spread_trend_gate_skip", result="skipped",
                          symbol=sym, details={"price": price})
                continue
```

Confirm `import screener_core` is already at the top of `wheel_strategy.py` (it is — the file already calls `screener_core.score_candidate` and `screener_core.build_universe`).

- [ ] **Step 4: Run tests to verify they pass.**

Run: `python -m pytest tests/test_auto_spread.py -v -k "below_sma20 or proceeds_above_sma20"`
Expected: 2 PASS.

- [ ] **Step 5: Run the full auto-spread suite as a regression check.**

Run: `python -m pytest tests/test_auto_spread.py -v`
Expected: ALL PASS. Existing orchestration tests use non-SM modes or mocked `cfg` without `trend_filter` → the `cfg.get("trend_filter")` returns False/None → gate is skipped. Byte-unaffected.

- [ ] **Step 6: Commit.**

```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "$(cat <<'EOF'
wheel_strategy: trend-filter gate in _auto_open_spread (SM modes)

When cfg.trend_filter is True, a candidate must be at or above its
20-day SMA to be considered. Wires screener_core.is_above_sma20 to
the new get_recent_daily_closes fetcher. Fail-closed: missing history
skips the symbol. Non-SM modes leave the key unset — gate inactive.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Mode-isolation regression test

**Files:**
- Modify: `tests/test_modes_sm.py`

Belt-and-suspenders assertion that the four non-SM modes are byte-unaffected by the hardened-engine keys. Catches any future config edit that accidentally bleeds an SM key into another mode.

- [ ] **Step 1: Write the failing test.** Append to `tests/test_modes_sm.py`:

```python
def test_non_sm_modes_have_no_hardened_engine_keys():
    """The four non-SM modes must NOT carry any hardened-engine key.
    If this ever fails, an SM-only param leaked into another mode and
    will silently change its behavior."""
    import config
    hardened_keys = {
        "min_credit_to_width_pct",
        "spread_stop_credit_mult",
        "trend_filter",
        "screener_universe",
        "auto_open_spreads",          # already SM-only, restated for safety
        "max_underlying_price",       # sm500-only filter
    }
    for mode_name in ("conservative", "aggressive", "manual", "live"):
        cfg = config.MODES[mode_name]
        leaks = hardened_keys.intersection(cfg.keys())
        # auto_open_spreads is explicitly False on these modes already —
        # filter that one out since it's pre-existing not a hardening leak.
        leaks.discard("auto_open_spreads") if cfg.get("auto_open_spreads") is False else None
        assert not leaks, (
            f"{mode_name} has hardened-engine keys leaked into its config: {leaks}"
        )
```

- [ ] **Step 2: Run test to verify it passes immediately** (no implementation needed if the prior tasks were done correctly — this is the regression net).

Run: `python -m pytest tests/test_modes_sm.py -v -k non_sm_modes_have_no_hardened`
Expected: PASS.

If it FAILS, an earlier task accidentally edited the wrong mode block. Fix the config and re-run.

- [ ] **Step 3: Run the full test suite as a final regression sweep.**

Run: `python -m pytest tests/ -v`
Expected: ALL PASS. (Note: ~380 pytest count per CLAUDE.md, plus the new tests from tasks 1–12 should net ~22+ new tests.)

- [ ] **Step 4: Commit.**

```bash
git add tests/test_modes_sm.py
git commit -m "$(cat <<'EOF'
tests: assert non-SM modes have no hardened-engine keys leaked

Belt-and-suspenders regression net. If a future config edit accidentally
copies an SM-only key into conservative/aggressive/manual/live, this
test fails loudly instead of silently changing those modes' behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (the "SM auto-spread engine" section)

Documents what changed so future-Tim and future-Claude can read the current behavior without spelunking commits.

- [ ] **Step 1: Read the existing "SM auto-spread engine" section** in `CLAUDE.md` to anchor your edit (search for `### SM auto-spread engine`).

- [ ] **Step 2: Append a new subsection** below the existing engine description, before the next `###` heading:

````markdown
**Hardened-engine update (2026-05-19).** After the SM accounts bled −$280 / −8% across two trading days (sm500 $500→$451.51, sm1000 $1k→$863.43, sm2000 $2k→$1,904.58), the engine was hardened on four structural faults: no credit-to-risk floor, narrowest-width selection, a 10-min-cycle-gated stop that slipped past its trigger on illiquid chains, and a universe filter that forced the cheapest junk names. Plan: [2026-05-19-sm-pcs-hardening.md](docs/superpowers/plans/2026-05-19-sm-pcs-hardening.md). Spec: [2026-05-19-sm-pcs-hardening-design.md](docs/superpowers/specs/2026-05-19-sm-pcs-hardening-design.md).

Posture table:

| Param | sm500 (Conservative) | sm1000 / sm2000 (Balanced) | Other modes |
|---|---|---|---|
| `min_credit_to_width_pct` | 0.40 | 0.33 | — (gate inactive) |
| `max_risk_pct_equity` | 0.10 | 0.10 | n/a |
| `max_concurrent_spreads` | 1 | 2 / 3 | n/a |
| `spread_stop_credit_mult` | 2.0 | 2.0 | None → falls back to 0.50 of max_loss |
| `trend_filter` | True | True | unset → inactive |
| `screener_universe` | SM_CURATED_UNIVERSE | SM_CURATED_UNIVERSE | None → DEFAULT_CONSERVATIVE_UNIVERSE |

Behavioral changes:
1. **Credit-to-width floor** — `_auto_open_spread` rejects any candidate whose `net_credit / width < min_credit_to_width_pct`. Replaces the toothless `$0.05` absolute floor as the real gate.
2. **Best-ratio width selection** — same risk ceiling, but picks the highest payoff/risk width instead of the narrowest.
3. **2× credit stop** — `handle_spread` fires at `close_cost ≥ 2 × net_credit` for SM modes (a small bounded dollar loss the cron can catch). Non-SM modes keep the legacy 50%-of-max-loss path.
4. **Underlying-price tripwire** — SM-only: if the stock crosses the short strike, close immediately, independent of option quote quality.
5. **Curated universe + 20-day SMA trend gate** — `SM_CURATED_UNIVERSE` (12 quality names) replaces the cheap-junk path; trade only when underlying ≥ SMA20.

Validation: forward-paper on the reset SM accounts (Cutover Task 0 wiped state files; Tim reset Alpaca sub-accounts to $500/$1k/$2k and rotated keys before the hardened engine went live). T0 = first hardened-engine cycle. 2-week window. Primary success metric is **avg-win / avg-loss ratio**, not win rate alone.
````

- [ ] **Step 3: Commit.**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
CLAUDE.md: document hardened SM auto-spread engine

Captures the four structural fixes (credit-to-width floor, best-ratio
width selection, 2x credit stop + underlying tripwire, curated universe
+ SMA20 trend filter) and the Conservative/Balanced posture split.
Validation framing: forward-paper, 2-week window, judge on avg-win /
avg-loss ratio.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (writer's checklist — completed)

**Spec coverage:**
- §1 Credit-to-width floor → Task 9 ✓
- §2 Width selection — best ratio → Task 10 ✓
- §3a Stop: 2× credit trigger → Tasks 6, 7 ✓
- §3b Underlying-price tripwire → Task 8 ✓
- §3c Resting GTC stop (stretch) → intentionally out of v1 per spec, not planned ✓
- §4 Curated universe + trend filter → Tasks 1, 2, 3, 11 ✓
- §5 Risk-cap tightening + posture split → Tasks 4, 5 ✓
- §6 Validation → Cutover (Task 0) records T0; measurement is operational, not code ✓
- §7 Cutover (T0 prep) → Task 0 ✓
- Testing section (mocked, isolation) → every code task pairs failing test + minimal impl; Task 12 is the isolation belt-and-suspenders ✓

**Placeholder scan:** No TBD/TODO. Every code step has actual code. Every test step has actual test code. Every commit has a real message.

**Type / name consistency:** `SPREAD_STOP_CREDIT_MULT` used identically across Tasks 6/7/8. `credit_ratio_passes` defined Task 9, referenced Task 10. `pick_best_ratio_width` defined Task 10. `get_recent_daily_closes` defined Task 3, referenced Task 11. `SM_CURATED_UNIVERSE` defined Task 1, referenced Tasks 4/5/12/13. `is_above_sma20` defined Task 2, referenced Task 11.

**Scope:** Single implementation plan; one feature; under 14 tasks; no decomposition needed.
