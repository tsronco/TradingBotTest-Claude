# Small-Account Auto-Spread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up 3 low-balance paper accounts (`sm500`/`sm1000`/`sm2000`) that manage hand-opened positions like `manual` and autonomously open earnings-screened, risk-capped put credit spreads from a reused (DRY-refactored) wheel-screener; plus a dashboard group-view account selector for all 7 accounts.

**Architecture:** Extract the screener score into a shared importable core (no behavior change), add 3 MODES entries (manual flags + a new `auto_open_*` param block), add a yfinance earnings guard, build a new screener-driven `_open_spread_mleg`/`_auto_open_spread` engine in `wheel_strategy.py` (exits reuse manual's existing `handle_spread`), wire 3 workflows + cron slots, and generalize the dashboard account model to a selected-set with Small/Core/Hands-on group chips. Bot = Python (pytest, Alpaca/yfinance mocked in `conftest.py`); dashboard = Vite/React/TS (vitest, `erasableSyntaxOnly`).

**Spec:** [2026-05-15-small-account-auto-spread-design.md](docs/superpowers/specs/2026-05-15-small-account-auto-spread-design.md) — all 6 decisions resolved.

**Branch:** `claude/small-account-auto-spread` (off `main`).

**Test commands:** bot `python -m pytest tests/ -v`; dashboard `cd dashboard && npx vitest run --pool=threads` (forks pool times out in sandbox) + `npx tsc -p tsconfig.app.json --noEmit`. Keep all green after every task. Tim handles GitHub Actions secrets + cron-job.org apply + deploy (flagged in Phase 7).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `screener_core.py` | Create | Shared, pure, importable scoring + universe build (extracted from `wheel_screener.py`). |
| `wheel_screener.py` | Modify | Import from `screener_core`; CLI/Discord output byte-unchanged. |
| `config.py` | Modify | Expanded ~60-name conservative pool; `sm500/sm1000/sm2000` MODES entries (manual flags + `auto_open_*` block + `max_underlying_price`). |
| `earnings.py` | Create | `next_earnings_within(symbol, days) -> bool` — yfinance, per-run cache, bounded retry. |
| `requirements.txt` | Modify | Add pinned `yfinance` (+ its needed deps already present? verify). |
| `wheel_strategy.py` | Modify | `_open_spread_mleg`, `normalize_scores`, `bp_wants_spread`, risk-rail guards, `_auto_open_spread`; wire into per-cycle flow gated by `AUTO_OPEN_SPREADS`. |
| `daily_summary.py` | Modify | Include sm500/sm1000/sm2000 in the per-mode summary loop (no head-to-head). |
| `tools/setup_cronjobs.py` | Modify | 3 new JOBS entries (offsets `:05`/`:08`/`:06`). |
| `.github/workflows/tsla-monitor-sm500.yml` | Create | Copy of manual workflow, `--mode sm500`, SM state files/push. |
| `.github/workflows/tsla-monitor-sm1000.yml` | Create | Same, `sm1000`. |
| `.github/workflows/tsla-monitor-sm2000.yml` | Create | Same, `sm2000`. |
| `tests/test_screener_core.py` | Create | Scoring parity + universe build. |
| `tests/test_auto_spread.py` | Create | normalize/bp-switch/guards/mleg-body/earnings — all mocked. |
| `tests/test_modes_sm.py` | Create | Mode isolation for the 3 SM modes + flag correctness. |
| `dashboard/src/hooks/useAccount.ts` etc. | Modify | Register 3 accounts; selected-set + group chips. |
| `dashboard/tests/...` | Modify/Create | Group-selector + multi-account render logic. |

**No change to:** `strategy.py` flow (SM uses its existing manual auto-discover path unchanged), the dashboard's Alpaca SDK bypass, `/api/trades/submit`, bot order-management of hand-opened positions.

---

## Phase 1 — Screener-core refactor (DRY, zero behavior change) + universe expansion

### Task 1.1: Characterize current screener output (baseline)

**Files:** Read `wheel_screener.py` (esp. `score_candidate` ~226-268, `run_screener` ~286, UNIVERSE build ~118-119, `DEFAULT_CONSERVATIVE_UNIVERSE` ~45).

- [ ] **Step 1:** Read and record verbatim: the exact `score_candidate(symbol, free_bp)` body, the score formula (`premium_yield*100 - spread_pct*50 + budget_fit*5`), the returned dict keys, how `run_screener` builds `UNIVERSE` from `cfg["screener_universe"] or DEFAULT_CONSERVATIVE_UNIVERSE` minus `ALREADY_WHEELED`, and how it fetches option data (`api_get`/`find_*`). No code change. This is the contract Phase 1 must preserve byte-for-byte.

### Task 1.2: Extract `screener_core.py` (TDD — parity)

**Files:** Create `screener_core.py`, `tests/test_screener_core.py`; Modify `wheel_screener.py`

- [ ] **Step 1: Write the failing parity test.**

```python
# tests/test_screener_core.py
import screener_core

def test_score_formula_matches_legacy_constants():
    # Pin the exact scoring math so the refactor cannot drift it.
    r = screener_core.score_from_quote(strike=100.0, bid=2.0, ask=2.2, free_bp=50_000.0)
    # premium_yield = bid/strike = 0.02 -> *100 = 2.0
    # spread_pct = (ask-bid)/mid = 0.2/2.1 = 0.095238 -> *50 = 4.7619
    # budget_fit = collateral(100*100=10000) <= 50000 -> 1.0 -> *5 = 5
    assert round(r["premium_yield"], 6) == 0.02
    assert round(r["score"], 4) == round(2.0 - 4.7619047619 + 5.0, 4)
    assert r["budget_fit"] is True

def test_budget_fit_false_when_collateral_exceeds_bp():
    r = screener_core.score_from_quote(strike=100.0, bid=2.0, ask=2.1, free_bp=5_000.0)
    assert r["budget_fit"] is False  # 10000 > 5000
```

- [ ] **Step 2: Run → FAIL** (`screener_core` missing). `python -m pytest tests/test_screener_core.py -v`

- [ ] **Step 3: Implement `screener_core.py`** — move the *pure* scoring math out of `wheel_screener.py` into a dependency-free function. Keep the exact formula. Provide both a low-level `score_from_quote(strike, bid, ask, free_bp)` (pure, unit-testable) and the existing-shaped `score_candidate(symbol, free_bp, *, api_get)` that fetches the contract via an injected `api_get` callable and delegates the math to `score_from_quote`. Reproduce the legacy returned-dict keys exactly (`symbol, price, strike, expiry, option_symbol, bid, ask, mid, premium_yield, spread_pct, collateral, budget_fit, score`). Also move the universe builder: `build_universe(cfg_universe, already_wheeled) -> list[str]` = `sorted(set(cfg_universe or DEFAULT_CONSERVATIVE_UNIVERSE) - set(already_wheeled))`. Export `DEFAULT_CONSERVATIVE_UNIVERSE`.

- [ ] **Step 4:** Refactor `wheel_screener.py` to `from screener_core import score_candidate, build_universe, DEFAULT_CONSERVATIVE_UNIVERSE` and delete the now-moved bodies; the CLI/Discord formatting stays in `wheel_screener.py`, untouched. The injected `api_get` is `wheel_screener`'s existing one.

- [ ] **Step 5: Run → PASS** `tests/test_screener_core.py`. Then full `python -m pytest tests/ -v` → all pre-existing screener tests still green (the refactor is behavior-preserving; if a screener test asserts on internal structure that moved, update the import path only — never weaken the assertion).

- [ ] **Step 6: Commit.**
```bash
git add screener_core.py wheel_screener.py tests/test_screener_core.py
git commit -m "refactor: extract shared screener_core (no behavior change)"
```

### Task 1.3: Expand the conservative universe to ~60 names

**Files:** Modify `screener_core.py` (the `DEFAULT_CONSERVATIVE_UNIVERSE` list)

- [ ] **Step 1:** Expand `DEFAULT_CONSERVATIVE_UNIVERSE` from ~40 to **~60** liquid, optionable, large-cap "happy to own" names (within Tim's 50–100 ask). Keep the existing entries; add ~20 well-known liquid optionable large-caps spanning sectors (e.g. AAPL, MSFT, NVDA-tier are high-priced — fine for sm1000/sm2000; ensure a healthy subset is ≤ $25 so sm500's price filter still yields candidates: e.g. F, T, INTC, SOFI, PFE, BAC, NIO, CCL, KMI, etc.). No code logic change — list only.

- [ ] **Step 2: Add a test** asserting `50 <= len(DEFAULT_CONSERVATIVE_UNIVERSE) <= 100`, all entries are uppercase non-empty unique strings, and **at least 8** entries are "known cheap" (assert a documented sub-list of intended ≤$25 names is a subset — so sm500 has candidates). Run → PASS. Full pytest green.

- [ ] **Step 3: Commit.**
```bash
git add screener_core.py tests/test_screener_core.py
git commit -m "feat: expand conservative screener universe to ~60 names"
```

---

## Phase 2 — config.MODES: 3 SM modes + auto-open param block

### Task 2.1: Add the SM modes (TDD — isolation)

**Files:** Modify `config.py`; Create `tests/test_modes_sm.py`

- [ ] **Step 1: Write the failing isolation test.**

```python
# tests/test_modes_sm.py
import config

SM = ["sm500", "sm1000", "sm2000"]

def test_sm_modes_exist_and_are_isolated():
    seen_keys, seen_state, seen_chan = set(), set(), set()
    for m in SM:
        cfg = config.get_mode(m)
        # distinct Alpaca creds env names
        assert cfg["alpaca_key_env"] == f"ALPACA_{m.upper()}_API_KEY"
        assert cfg["alpaca_secret_env"] == f"ALPACA_{m.upper()}_API_SECRET"
        assert cfg["alpaca_url_env"] == f"ALPACA_{m.upper()}_BASE_URL"
        # distinct state files
        assert cfg["wheel_state_file"] == f"wheel_state_{m}.json"
        assert cfg["strategy_state_file"] == f"strategy_state_{m}.json"
        # distinct discord channels
        for ch in ("trades_channel", "summary_channel", "errors_channel", "actions_channel"):
            seen_chan.add(cfg[ch])
        seen_keys.add(cfg["alpaca_key_env"]); seen_state.add(cfg["wheel_state_file"])
    assert len(seen_keys) == 3 and len(seen_state) == 3 and len(seen_chan) == 12

def test_sm_modes_inherit_manual_management_flags():
    for m in SM:
        cfg = config.get_mode(m)
        assert cfg["auto_discover_symbols"] is True
        assert cfg["spread_management"] is True
        assert cfg["wheel_skip_new_puts"] is True   # static CSP wheel stays OFF

def test_auto_open_only_on_sm_modes():
    for m in SM:
        assert config.get_mode(m)["auto_open_spreads"] is True
    for m in ("conservative", "aggressive", "manual", "live"):
        assert config.get_mode(m).get("auto_open_spreads", False) is False

def test_auto_open_param_block_defaults():
    c = config.get_mode("sm1000")
    assert c["bp_switch_threshold"] == 5000
    assert c["wheelability_min"] == 90
    assert c["max_risk_pct_equity"] == 0.12
    assert c["max_concurrent_spreads"] == 3
    assert c["account_floor"] == 300
    assert c["earnings_exclusion_days"] == 7
    assert c["max_opens_per_cycle"] == 1
    assert c["short_put_otm_pct"] == 0.10
    assert c["spread_dte_min"] == 14 and c["spread_dte_max"] == 28
    # sm500-only universe price filter; sm1000/sm2000 unfiltered (None)
    assert config.get_mode("sm500")["max_underlying_price"] == 25
    assert config.get_mode("sm1000").get("max_underlying_price") is None
```

- [ ] **Step 2: Run → FAIL.** `python -m pytest tests/test_modes_sm.py -v`

- [ ] **Step 3: Implement** — add `sm500`/`sm1000`/`sm2000` to `MODES` in `config.py`. Start from a verbatim copy of the `manual` entry (so all management flags + wheel params match), then per mode set: `alpaca_*_env` → `ALPACA_SM{N}_*`; `*_channel` → `sm{n}_{trades,summary,errors,actions}`; `log_stream` → `sm{n}`; `wheel_state_file`/`strategy_state_file` → `*_sm{n}.json`; `screener_universe: None` (→ uses the expanded conservative default). Append the new `auto_open_*` param block to all three (values from `test_auto_open_param_block_defaults`). Set `max_underlying_price: 25` on sm500 only; `None` on sm1000/sm2000. Confirm `parse_mode_arg`/`get_mode` need no change (they're generic over MODES keys).

- [ ] **Step 4: Run → PASS** `tests/test_modes_sm.py`; full `python -m pytest tests/ -v` green (existing mode tests unaffected — additive keys).

- [ ] **Step 5: Commit.**
```bash
git add config.py tests/test_modes_sm.py
git commit -m "feat: add sm500/sm1000/sm2000 modes + auto-open param block"
```

---

## Phase 3 — Earnings guard (yfinance in the bot)

### Task 3.1: `earnings.py` helper (TDD — mocked yfinance)

**Files:** Create `earnings.py`, `tests/test_earnings.py`; Modify `requirements.txt`

- [ ] **Step 1:** Add pinned `yfinance` to `requirements.txt` (a version known-good with the repo's Python 3.12; mirror the pin style used in `dashboard/requirements.txt` if compatible). Note: production GitHub Actions installs `requirements.txt` — adding yfinance is intentional and required.

- [ ] **Step 2: Write the failing test** (yfinance fully mocked — tests never hit network):

```python
# tests/test_earnings.py
import datetime as dt
from unittest.mock import patch
import earnings

def _mk(days_out):
    when = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days_out)
    return when

def test_blocks_when_earnings_within_window():
    with patch("earnings._next_earnings_dt", return_value=_mk(3)):
        assert earnings.next_earnings_within("F", 7) is True

def test_clear_when_earnings_outside_window():
    with patch("earnings._next_earnings_dt", return_value=_mk(30)):
        assert earnings.next_earnings_within("F", 7) is False

def test_unknown_earnings_is_treated_as_blocked_by_default():
    # No data -> conservative: assume risk, block (don't sell blind into a possible print)
    with patch("earnings._next_earnings_dt", return_value=None):
        assert earnings.next_earnings_within("ZZZZ", 7) is True

def test_per_run_cache_avoids_duplicate_lookups():
    earnings._CACHE.clear()
    with patch("earnings._next_earnings_dt", return_value=_mk(30)) as m:
        earnings.next_earnings_within("F", 7)
        earnings.next_earnings_within("F", 7)
        assert m.call_count == 1  # second call served from cache
```

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement `earnings.py`:**

```python
"""Earnings-date guard for the autonomous spread opener.

Conservative by design: if we cannot determine the next earnings date,
we treat the symbol as BLOCKED (better to skip a trade than sell premium
blind into a possible earnings print). Per-run in-memory cache; bounded
retry around the (rate-limited) yfinance call.
"""
import datetime as dt
import time
from typing import Optional

_CACHE: dict[str, Optional[dt.datetime]] = {}
_MAX_ATTEMPTS = 3
_BACKOFFS = (1, 3)


def _next_earnings_dt(symbol: str) -> Optional[dt.datetime]:
    import yfinance as yf
    for attempt in range(_MAX_ATTEMPTS):
        try:
            edf = yf.Ticker(symbol).get_earnings_dates(limit=8)
            if edf is None or len(edf) == 0:
                return None
            now = dt.datetime.now(dt.timezone.utc)
            future = [ix.to_pydatetime() for ix in edf.index
                      if ix.to_pydatetime().astimezone(dt.timezone.utc) >= now]
            return min(future).astimezone(dt.timezone.utc) if future else None
        except Exception:
            if attempt + 1 < _MAX_ATTEMPTS:
                time.sleep(_BACKOFFS[attempt])
                continue
            return None
    return None


def next_earnings_within(symbol: str, days: int) -> bool:
    """True = earnings within `days` (or unknown) -> caller should SKIP."""
    if symbol not in _CACHE:
        _CACHE[symbol] = _next_earnings_dt(symbol)
    nxt = _CACHE[symbol]
    if nxt is None:
        return True  # unknown -> conservative block
    delta = (nxt - dt.datetime.now(dt.timezone.utc)).total_seconds()
    return 0 <= delta <= days * 86400
```

- [ ] **Step 5: Run → PASS** `tests/test_earnings.py`; full pytest green.

- [ ] **Step 6: Commit.**
```bash
git add earnings.py requirements.txt tests/test_earnings.py
git commit -m "feat: yfinance earnings guard (conservative: unknown = blocked)"
```

---

## Phase 4 — The auto-open engine

### Task 4.1: Score normalization + BP switch (pure, TDD)

**Files:** Modify `wheel_strategy.py`; Create `tests/test_auto_spread.py`

- [ ] **Step 1: Write failing tests.**

```python
# tests/test_auto_spread.py
import wheel_strategy as ws

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
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** in `wheel_strategy.py`:

```python
def normalize_scores(raw: dict[str, float]) -> dict[str, float]:
    """Percentile-rank raw screener scores to 0-100 within this cycle's set.
    100 = best, 0 = worst. Singleton -> 100. Empty -> {}."""
    if not raw:
        return {}
    if len(raw) == 1:
        return {k: 100.0 for k in raw}
    ordered = sorted(raw.items(), key=lambda kv: kv[1])
    n = len(ordered)
    return {sym: round(i / (n - 1) * 100.0, 4) for i, (sym, _) in enumerate(ordered)}


def bp_wants_spread(options_bp: float, threshold: float) -> bool:
    """Below the BP threshold -> open a defined-risk spread instead of a CSP."""
    return options_bp < threshold
```

- [ ] **Step 4: Run → PASS.**

### Task 4.2: Risk-rail guards (pure, TDD)

**Files:** Modify `wheel_strategy.py`, `tests/test_auto_spread.py`

- [ ] **Step 1: Append failing tests** — `spread_passes_risk(width, equity, max_risk_pct)` (max loss = width*100 ≤ equity*pct), `under_concurrency(open_spreads, cap)`, `above_account_floor(equity, floor)`, `bp_fits(options_bp, width, buffer)`, and `eligible_universe(cfg, prices)` (sm500 filters to `price <= max_underlying_price`; sm1000/sm2000 pass all). Include the exact arithmetic in asserts (e.g. `spread_passes_risk(1.0, 500, 0.12)` → False because 100 > 60; `spread_passes_risk(1.0, 1000, 0.12)` → False (100 > 120? no, 100<=120 → True) — write the precise expected booleans).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** the five small pure predicates in `wheel_strategy.py`:

```python
def spread_passes_risk(width: float, equity: float, max_risk_pct: float) -> bool:
    return (width * 100.0) <= equity * max_risk_pct

def under_concurrency(open_spreads: int, cap: int) -> bool:
    return open_spreads < cap

def above_account_floor(equity: float, floor: float) -> bool:
    return equity >= floor

def bp_fits(options_bp: float, width: float, buffer: float = 1.0) -> bool:
    return options_bp >= (width * 100.0) * buffer

def eligible_universe(symbols_prices: dict[str, float], max_price) -> list[str]:
    if max_price is None:
        return list(symbols_prices)
    return [s for s, px in symbols_prices.items() if px <= max_price]
```

- [ ] **Step 4: Run → PASS** all of `tests/test_auto_spread.py` so far. Commit.
```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "feat: auto-spread score normalization + BP switch + risk guards"
```

### Task 4.3: `_open_spread_mleg` (TDD — mocked api_post)

**Files:** Modify `wheel_strategy.py`, `tests/test_auto_spread.py`

- [ ] **Step 1: Append failing test** — assert `_open_spread_mleg(short_occ, long_occ, qty, limit_credit)` calls `api_post("/orders", body)` with `order_class="mleg"`, `type="limit"`, `time_in_force="day"`, and legs = `[{symbol:short_occ, side:"sell", ratio_qty:"1", position_intent:"sell_to_open"}, {symbol:long_occ, side:"buy", ratio_qty:"1", position_intent:"buy_to_open"}]`, `qty=str(qty)`, and the limit price is the **negative** of the net credit (credit convention, mirroring the dashboard's `limit_price: -limitCredit`) — patch `wheel_strategy.api_post` with a capture mock; assert the captured body exactly.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `_open_spread_mleg` mirroring the existing `_close_spread_mleg` (lines ~264-289) structure but for opening:

```python
def _open_spread_mleg(short_occ: str, long_occ: str, qty: int, net_credit: float):
    """Submit an Alpaca multi-leg sell-to-open put credit spread.
    Mirrors _close_spread_mleg; opposite intents. Limit = -net_credit
    (negative => credit received), matching the dashboard convention."""
    return api_post("/orders", {
        "order_class":   "mleg",
        "qty":           str(qty),
        "type":          "limit",
        "limit_price":   str(round(-abs(net_credit), 2)),
        "time_in_force": "day",
        "legs": [
            {"symbol": short_occ, "side": "sell", "ratio_qty": "1", "position_intent": "sell_to_open"},
            {"symbol": long_occ,  "side": "buy",  "ratio_qty": "1", "position_intent": "buy_to_open"},
        ],
    })
```

- [ ] **Step 4: Run → PASS.** Commit.
```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "feat: _open_spread_mleg multi-leg put-credit-spread open primitive"
```

### Task 4.4: `_auto_open_spread` orchestration + per-cycle wiring (TDD — fully mocked)

**Files:** Modify `wheel_strategy.py`, `tests/test_auto_spread.py`

- [ ] **Step 1: Append failing tests** for `_auto_open_spread(state, account, cfg)` with everything mocked (`screener_core.score_candidate`, `get_account`, `earnings.next_earnings_within`, contract lookup, `_open_spread_mleg`). Assert these behaviors, one test each:
  - **Happy path:** universe scored → normalized → top symbol ≥ `wheelability_min`, earnings clear, BP < threshold, width passes risk + bp-fit, under concurrency, above floor → `_open_spread_mleg` called once with correctly-chosen short(~10% OTM)/long legs; state seeded as `stage:"spread_active"` (existing `_empty_spread_state` shape) so management adopts it.
  - **Earnings block:** top symbol has earnings within `earnings_exclusion_days` → skipped, next-best tried; if none clear → no order, logged.
  - **Risk cap block:** sm500 path — cheapest width still `width*100 > equity*0.12` → no order (this is the documented sm500-mostly-no-trade case); assert a clear "no trade within risk budget" log event, not an error.
  - **Concurrency cap:** `open_spreads >= max_concurrent_spreads` → returns immediately, no scoring.
  - **Account floor:** equity < `account_floor` → returns immediately.
  - **sm500 universe filter:** with `max_underlying_price=25`, a $40 underlying is excluded from scoring even if it would score highest.
  - **max_opens_per_cycle:** at most one `_open_spread_mleg` call even if several candidates qualify.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `_auto_open_spread(state, account, cfg)`** in `wheel_strategy.py`. Order of operations exactly: (1) if `not AUTO_OPEN_SPREADS` return; (2) `equity = float(get_account()["equity"])`; if `not above_account_floor(equity, cfg["account_floor"])` → log+return; (3) count existing `spread_active` entries in `state`; if `not under_concurrency(count, cfg["max_concurrent_spreads"])` → log+return; (4) build universe via `screener_core.build_universe(cfg["screener_universe"], already_wheeled)`; fetch underlying prices; apply `eligible_universe(prices, cfg.get("max_underlying_price"))`; (5) `raw = {sym: screener_core.score_candidate(sym, free_bp, api_get=api_get)["score"] for sym in eligible if data}`; `norm = normalize_scores(raw)`; (6) iterate symbols by descending `norm`; for each with `norm[sym] >= cfg["wheelability_min"]`: skip if `earnings.next_earnings_within(sym, cfg["earnings_exclusion_days"])`; require `bp_wants_spread(options_bp, cfg["bp_switch_threshold"])` (always True for SM); pick short put ≈ `cfg["short_put_otm_pct"]` OTM within `spread_dte_min/max` (reuse existing `find_best_contract`/strike rounding), long put one strike below for the **narrowest width** that satisfies `spread_passes_risk(width, equity, cfg["max_risk_pct_equity"])` AND `bp_fits(options_bp, width)`; if none satisfies → continue to next symbol; (7) on first fully-eligible symbol: compute net credit (short mid − long mid), `_open_spread_mleg(short_occ, long_occ, qty=1, net_credit)`, seed `state[sym]` from `_empty_spread_state()` populated with legs/width/credit/expiration/`opened_at`, log a `#sm{n}_trades` adoption-style embed, and **return after one open** (`max_opens_per_cycle`=1). Use the existing logging/Discord helpers (mode-routed) the wheel already uses. Add module global `AUTO_OPEN_SPREADS` populated in `apply_mode` from `cfg.get("auto_open_spreads", False)`.

- [ ] **Step 4: Wire into the per-cycle flow.** In `run_wheel` (after the existing discover + manage-hand-opened + `handle_spread` management passes, BEFORE cycle end), add: `if AUTO_OPEN_SPREADS: _auto_open_spread(state, account, config.get_mode(MODE))`. Management of the just-opened spread happens on subsequent cycles via the existing `handle_spread` (no new exit code). Confirm `apply_mode` sets `AUTO_OPEN_SPREADS` (Task 4.4 Step 3).

- [ ] **Step 5: Run → PASS** all `tests/test_auto_spread.py`; full `python -m pytest tests/ -v` green (existing wheel tests unaffected — new path gated by `AUTO_OPEN_SPREADS`, off for cons/agg/manual/live).

- [ ] **Step 6: Commit.**
```bash
git add wheel_strategy.py tests/test_auto_spread.py
git commit -m "feat: _auto_open_spread engine wired into wheel cycle (SM modes only)"
```

---

## Phase 5 — Workflows, cron, daily summary

### Task 5.1: Three monitor workflows

**Files:** Create `.github/workflows/tsla-monitor-sm500.yml`, `-sm1000.yml`, `-sm2000.yml`

- [ ] **Step 1:** Copy `.github/workflows/tsla-monitor-manual.yml` to each new file. In each: rename `name:` (`SM500 Monitor` etc.); change every `--mode manual` → `--mode sm500` (resp. sm1000/sm2000) on the strategy, wheel, long-options, and `push_rules_to_dashboard.py` invocations; change the dashboard-push state-file paths and `--mode` to the SM mode; change the bot-state push key/`--mode`. Keep the shared `concurrency: group: bot-commits` (serializes state commits across all accounts — do NOT give SM its own group, or it'll race the others on the same repo). Keep checkout/python/install/commit steps identical.

- [ ] **Step 2: Manual-reasoned verification** (no CI to run them here): diff each new yml against the manual one and confirm the ONLY differences are the mode token, state-file names, and workflow name — nothing structural. Record the diff in the task notes.

- [ ] **Step 3: Commit.**
```bash
git add .github/workflows/tsla-monitor-sm500.yml .github/workflows/tsla-monitor-sm1000.yml .github/workflows/tsla-monitor-sm2000.yml
git commit -m "ci: add sm500/sm1000/sm2000 monitor workflows"
```

### Task 5.2: Cron slots + daily summary

**Files:** Modify `tools/setup_cronjobs.py`, `daily_summary.py`

- [ ] **Step 1:** In `tools/setup_cronjobs.py` add 3 JOBS entries mirroring the manual monitor entry, dispatching the 3 new workflows on **`5,15,25,35,45,55 13-20 * * 1-5`** (sm500), **`8,18,28,38,48,58 13-20 * * 1-5`** (sm1000), **`6,16,26,36,46,56 13-20 * * 1-5`** (sm2000) — these minute-offsets don't collide with cons `:07`/agg `:09`/manual `:01`/live `:03`. Idempotent PATCH-or-create is the existing script behavior — no change to that logic. **Running the script is a Tim action** (it mutates cron-job.org); the plan only adds the entries.

- [ ] **Step 2:** In `daily_summary.py` add `sm500`/`sm1000`/`sm2000` to the per-mode summary loop (same path as `manual`/`live` — a standalone per-mode embed to `#sm{n}_summary`; **not** in the cons/agg head-to-head — different capital base). Find the existing mode list the summary iterates and extend it; reuse the manual summary code path (multi-symbol state + spreads field already supported).

- [ ] **Step 3:** Add/extend a pytest asserting `daily_summary` enumerates the 3 SM modes and routes each to its own summary channel (mirror any existing daily-summary mode test; mocked). Run → PASS; full pytest green.

- [ ] **Step 4: Commit.**
```bash
git add tools/setup_cronjobs.py daily_summary.py tests/
git commit -m "ci: sm cron slots + daily-summary inclusion (no head-to-head)"
```

---

## Phase 6 — Dashboard: register 3 accounts + group-view selector

### Task 6.1: Register the 3 accounts across all enumeration sites

**Files:** Modify `dashboard/src/hooks/useAccount.ts`, `dashboard/src/components/layout/Sidebar.tsx`, `dashboard/api/_lib/alpaca.ts`, `dashboard/src/lib/account-utils.ts`, `dashboard/api/_lib/trade-types.ts`, `dashboard/src/lib/rule-check.ts` (+ touched tests)

- [ ] **Step 1:** Extend every account enumeration with `sm500`/`sm1000`/`sm2000` (+ `*_paper` ids): `AccountMode` union (`useAccount.ts`); `AccountId` union (`trade-types.ts`); `Mode`, `ALL_MODES`, `ALL_ACCOUNTS` (`account-utils.ts` — incl. `modeToAccount` mapping `smN → smN_paper`); `credsFor()` branches in `alpaca.ts` (`ALPACA_SM{N}_API_KEY/SECRET`); `accountToMode()` in `rule-check.ts`. Keep `erasableSyntaxOnly` (union literals only). Add the 3 single-account chips to `Sidebar.tsx` `acctOpts` (labels display `$500`/`$1,000`/`$2,000`, values `sm500`/`sm1000`/`sm2000`).

- [ ] **Step 2:** Update any test that snapshots the account list (e.g. `rule-check.test.ts`) to include the 3 new ones — extend, don't weaken. `npx tsc -p tsconfig.app.json --noEmit` 0; `npx vitest run --pool=threads` green.

- [ ] **Step 3: Commit.**
```bash
git add dashboard/src dashboard/api dashboard/tests
git commit -m "feat(dashboard): register sm500/sm1000/sm2000 accounts"
```

### Task 6.2: Group-view selector (TDD)

**Files:** Modify `dashboard/src/hooks/useAccount.ts`, `dashboard/src/components/layout/Sidebar.tsx`, `dashboard/src/lib/account-utils.ts`; the account-aware pages' "which accounts to render" derivation; Create `dashboard/tests/lib/account-groups.test.ts`

- [ ] **Step 1: Write the failing test** for a pure helper `accountsForSelection(sel)` in `account-utils.ts`: `'all'` → all 7; a single mode → `[that]`; `'small'` → `['sm500','sm1000','sm2000']`; `'core'` → `['conservative','aggressive']`; `'hands-on'` → `['manual','live']`. Assert each mapping exactly.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Add `'small' | 'core' | 'hands-on'` to the `AccountMode` selection union (alongside existing single modes + `'both'`/all). Add `accountsForSelection(sel): Mode[]` returning the resolved set. Add 3 group chips to `Sidebar.tsx` `acctOpts` (labels `small`/`core`/`hands-on`; keep single chips + All). Generalize the account-aware pages: wherever they branch on `mode==='both' ? ALL : [mode]`, replace with `accountsForSelection(mode)` so 1 / group / all all flow through one path. (Identify each such site via the existing `useAccount` consumers; the render code already maps an account array → cards, so this is a derivation swap, not a render rewrite.)

- [ ] **Step 4: Run → PASS** `account-groups.test.ts`; full vitest green; tsc 0. Manual device pass (visual group rendering) is Tim's, noted in Phase 7.

- [ ] **Step 5: Commit.**
```bash
git add dashboard/src dashboard/tests
git commit -m "feat(dashboard): Small/Core/Hands-on group-view account selector"
```

---

## Phase 7 — Validation, review, handoff

### Task 7.1: Full gate

- [ ] `python -m pytest tests/ -v` → all green (new: screener_core, modes_sm, earnings, auto_spread, daily-summary SM; existing suite unaffected).
- [ ] `cd dashboard && npx tsc -p tsconfig.app.json --noEmit` → 0; `npx vitest run --pool=threads` → all green.
- [ ] Grep the diff for accidental scope: no change to cons/agg/manual/live runtime behavior (the new wheel path is gated by `AUTO_OPEN_SPREADS`, false everywhere except SM — assert via `tests/test_modes_sm.py::test_auto_open_only_on_sm_modes`).

### Task 7.2: Final whole-effort review

- [ ] Dispatch a holistic reviewer over `git diff main..HEAD`: focus on (a) the screener refactor being truly behavior-preserving for the existing weekly screener, (b) `_auto_open_spread` ordering/guards correctness and that exits genuinely reuse `handle_spread` (no orphaned bot-opened spreads), (c) `AUTO_OPEN_SPREADS` isolation (cons/agg/manual/live untouched), (d) earnings "unknown = blocked" conservatism, (e) dashboard group-selector type/render coherence, (f) no secret/credential handling regressions.

### Task 7.3: Handoff (Tim actions — NOT automated here)

- [ ] Report to Tim. The following are **his** to do (the plan must not attempt them): (1) add the 9 `ALPACA_SM*` + 12 `DISCORD_SM*` values as **GitHub Actions secrets** (they're in `.env` already for local); (2) add the 9 `ALPACA_SM*` values as **Vercel env vars** for the dashboard; (3) run `python tools/setup_cronjobs.py` to create the 3 cron-job.org slots; (4) deploy dashboard (`cd dashboard && npx vercel link --yes --project tradingbot-dashboard` then `npx vercel --prod`); (5) the dashboard group-selector manual-device pass. Branch stays unpushed / no PR / no deploy until Tim says, same as prior efforts.
- [ ] Update `CLAUDE.md` (architecture diagram + a "Small-account auto-spread" subsection + test-count bump) — commit on branch.

---

## Risk / rollback

- **The autonomous opener is the highest-risk code in the system.** Mitigations baked in: gated entirely behind `AUTO_OPEN_SPREADS` (only the 3 SM modes; cons/agg/manual/live byte-unaffected, asserted by test); every order passes earnings + risk-cap + BP-fit + concurrency + floor guards; ≤1 open/cycle; exits reuse the already-validated manual `handle_spread`; "unknown earnings = blocked" is fail-safe. All paper accounts — zero live/real-money exposure (live mode does not get `auto_open_spreads`).
- **Screener refactor** is behavior-preserving and pinned by a parity test before anything consumes it.
- **Rollback:** revert the branch — no DB/schema; cron slots are only created if Tim runs the script; workflows are inert until cron-job.org dispatches them; dashboard is additive. Each phase is an independent commit range.

## Self-review notes

- **Spec coverage:** P1↔screener reuse/DRY + universe expansion; P2↔3 modes + param block + sm500 filter; P3↔yfinance earnings guard (unknown=blocked); P4↔normalization+BP-switch+guards+mleg-open+orchestration+wiring; P5↔workflows/cron/daily-summary; P6↔dashboard 3 accounts + group selector; P7↔validation/review/Tim-handoff. All resolved-decision items mapped (percentile-90, $5k/12%, sm500≤$25, conservative pool, group names).
- **Signature consistency:** `score_from_quote`/`score_candidate`/`build_universe` (P1) used unchanged in P4; `normalize_scores`/`bp_wants_spread`/`spread_passes_risk`/`under_concurrency`/`above_account_floor`/`bp_fits`/`eligible_universe`/`_open_spread_mleg` defined in P4.1–4.3 and consumed by `_auto_open_spread` in 4.4 with matching arities; `next_earnings_within(symbol, days)` (P3) called in 4.4; `accountsForSelection` (P6.2) is the single render-derivation entry.
- **No placeholders:** pure logic fully coded (normalization, guards, mleg body, earnings helper, tests); config/workflow/dashboard tasks give exact paths + the verbatim manual-mode copy basis + enumeration-site list + precise structural steps (matches the proven mobile/order-form plan fidelity).
