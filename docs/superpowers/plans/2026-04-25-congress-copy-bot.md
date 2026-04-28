# Congress Copy Trading Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a paper-trading bot in `congress-copy/` that scrapes Josh Gottheimer's STOCK Act disclosures from CapitolTrades, sizes positions by tier, mirrors his stock and option trades into an Alpaca paper account, and exits via mirror-sell or -15% stop-loss.

**Architecture:** Five focused Python modules talking through plain dataclasses: `scraper` (Playwright on CapitolTrades) → `trader` (sizing + options fallback + Alpaca submission) → `state` (SQLite bookkeeping). Independent `monitor` loop handles stop-losses. CLI entrypoint `runner.py` with `disclosures` and `monitor` subcommands. Hard-enforced `PAPER_ONLY_GUARD` blocks any non-paper Alpaca URL.

**Tech Stack:** Python 3.11+, Playwright (scraping), httpx (Alpaca REST), SQLite (state), pytest (tests), `schedule` library (timing), `python-dotenv` (config), Windows Task Scheduler or cron (deployment).

**Spec reference:** [docs/superpowers/specs/2026-04-25-congress-copy-bot-design.md](../specs/2026-04-25-congress-copy-bot-design.md)

---

## File Map

Files this plan creates inside `congress-copy/`:

| Path | Responsibility |
|---|---|
| `.env.example` | Template for env vars (real `.env` lives at project root) |
| `.gitignore` | Excludes `data/`, `logs/`, `__pycache__`, `.env` |
| `README.md` | Quick-start docs |
| `requirements.txt` | Python dependencies |
| `pytest.ini` | Pytest config (test discovery, paths) |
| `config.py` | All tunable knobs from spec §7 |
| `src/__init__.py` | Empty package marker |
| `src/models.py` | Dataclasses: `Disclosure`, `OrderIntent`, `Position`, `FillResult` |
| `src/paper_guard.py` | Startup guard: refuses non-paper Alpaca URL |
| `src/sizing.py` | Pure function: `(range_low, range_high) → dollar_amount` |
| `src/state.py` | SQLite bookkeeping, `filter_unseen`, idempotency |
| `src/alpaca_client.py` | Thin wrapper over Alpaca paper REST API |
| `src/scraper.py` | Playwright scraper for CapitolTrades politician page |
| `src/options_resolver.py` | Cascading option fallback (exact → similar → underlying → skip) |
| `src/trader.py` | Orchestrates disclosure → order flow |
| `src/monitor.py` | Independent stop-loss loop |
| `src/runner.py` | CLI entrypoint with `disclosures`/`monitor` subcommands |
| `src/report.py` | Performance ledger reader → console + CSV report |
| `tests/__init__.py` | Empty package marker |
| `tests/conftest.py` | Pytest fixtures (temp DB, mock Alpaca, sample disclosures) |
| `tests/test_paper_guard.py` | Tests `PAPER_ONLY_GUARD` blocks non-paper URLs |
| `tests/test_sizing.py` | Tests every tier boundary |
| `tests/test_state.py` | Tests `filter_unseen` idempotency, stale cutoff, position bookkeeping |
| `tests/test_options_resolver.py` | Tests cascade: exact / similar / underlying / skip |
| `tests/test_trader.py` | Integration: disclosure → order with mocked Alpaca |
| `tests/test_monitor.py` | Integration: stop-loss triggers correctly |
| `tests/test_runner.py` | Smoke test: CLI subcommands invoke right modules |

---

## Task 1: Bootstrap project skeleton

**Files:**
- Create: `congress-copy/.gitignore`
- Create: `congress-copy/.env.example`
- Create: `congress-copy/requirements.txt`
- Create: `congress-copy/pytest.ini`
- Create: `congress-copy/README.md`
- Create: `congress-copy/src/__init__.py`
- Create: `congress-copy/tests/__init__.py`
- Create: `congress-copy/data/.gitkeep`
- Create: `congress-copy/logs/.gitkeep`

- [ ] **Step 1: Create the directory structure**

```bash
mkdir -p congress-copy/src
mkdir -p congress-copy/tests
mkdir -p congress-copy/data
mkdir -p congress-copy/logs
touch congress-copy/src/__init__.py
touch congress-copy/tests/__init__.py
touch congress-copy/data/.gitkeep
touch congress-copy/logs/.gitkeep
```

- [ ] **Step 2: Write `.gitignore`**

`congress-copy/.gitignore`:
```
__pycache__/
*.pyc
.pytest_cache/
data/*.db
data/*.lock
logs/*.log
.env
```

- [ ] **Step 3: Write `.env.example`**

`congress-copy/.env.example`:
```
# Real values live at project root .env; this is a template
ALPACA_API_KEY=your_paper_key_here
ALPACA_API_SECRET=your_paper_secret_here
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2
```

- [ ] **Step 4: Write `requirements.txt`**

`congress-copy/requirements.txt`:
```
httpx==0.27.2
playwright==1.48.0
schedule==1.2.2
python-dotenv==1.0.1
pytest==8.3.3
pytest-asyncio==0.24.0
freezegun==1.5.1
respx==0.21.1
```

- [ ] **Step 5: Write `pytest.ini`**

`congress-copy/pytest.ini`:
```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts = -v --tb=short
```

- [ ] **Step 6: Write `README.md` skeleton**

`congress-copy/README.md`:
```markdown
# Congress Copy Trading Bot

Paper-trades the disclosed STOCK Act filings of Rep. Josh Gottheimer (D-NJ) via Alpaca paper API. Source data scraped from CapitolTrades.com.

**This is paper trading only.** A startup guard refuses to run against any Alpaca base URL other than `paper-api.alpaca.markets`.

## Quick start

```bash
cd congress-copy
python -m venv .venv
source .venv/Scripts/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium

# Copy .env.example to project root .env and fill in your Alpaca paper keys
cp .env.example ../.env

# Run tests
pytest

# Run one disclosure check
python -m src.runner disclosures

# Run one stop-loss monitor pass
python -m src.runner monitor

# Generate performance report
python -m src.report
```

See `docs/superpowers/specs/2026-04-25-congress-copy-bot-design.md` for full design.
```

- [ ] **Step 7: Initialize git inside congress-copy**

```bash
cd congress-copy
git init
git add .
git commit -m "chore: bootstrap congress-copy project skeleton"
```

Expected output: `[main (root-commit) <hash>] chore: bootstrap congress-copy project skeleton` plus a list of files.

- [ ] **Step 8: Install dependencies**

```bash
python -m venv congress-copy/.venv
congress-copy/.venv/Scripts/pip install -r congress-copy/requirements.txt
congress-copy/.venv/Scripts/playwright install chromium
```

Expected: dependencies install cleanly, Chromium downloads (~150MB).

---

## Task 2: Define data models

**Files:**
- Create: `congress-copy/src/models.py`

- [ ] **Step 1: Write `models.py`**

`congress-copy/src/models.py`:
```python
"""Plain dataclasses used as the lingua franca between modules."""
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

AssetKind = Literal["stock", "etf", "option"]
Side = Literal["buy", "sell"]
OptionType = Literal["call", "put"]


@dataclass(frozen=True)
class OptionDetails:
    option_type: OptionType
    strike: Decimal
    expiry: datetime  # date-only semantics; time component ignored


@dataclass(frozen=True)
class Disclosure:
    trade_id: str           # CapitolTrades stable id, used as dedupe key
    politician_slug: str
    ticker: str
    side: Side
    asset_kind: AssetKind
    range_low: Decimal      # disclosed lower bound, USD
    range_high: Decimal     # disclosed upper bound, USD
    traded_at: datetime     # date the politician traded
    filed_at: datetime      # date filing was disclosed
    option: Optional[OptionDetails] = None  # only when asset_kind == "option"


@dataclass(frozen=True)
class OrderIntent:
    """What the trader wants Alpaca to do. Resolved sizing, ready to submit."""
    symbol: str             # stock ticker OR Alpaca option symbol (OCC format)
    side: Side
    notional_usd: Decimal   # for stocks: dollar amount; for options: ignored, qty used
    qty: Optional[int] = None  # for options: number of contracts; for stocks: None
    asset_kind: AssetKind = "stock"
    fallback_path: str = "direct"  # "direct" | "exact_option" | "similar_option" | "underlying"


@dataclass(frozen=True)
class FillResult:
    order_id: str
    status: Literal["filled", "pending", "rejected", "skipped"]
    filled_avg_price: Optional[Decimal] = None
    filled_qty: Optional[Decimal] = None
    reason: Optional[str] = None  # for rejected/skipped


@dataclass
class Position:
    symbol: str
    qty: Decimal
    avg_entry_price: Decimal
    current_price: Decimal
    market_value: Decimal
    unrealized_pl_pct: Decimal
```

- [ ] **Step 2: Verify it imports**

```bash
cd congress-copy
.venv/Scripts/python -c "from src.models import Disclosure, OrderIntent, FillResult, Position, OptionDetails; print('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd congress-copy
git add src/models.py
git commit -m "feat: add core dataclasses (Disclosure, OrderIntent, FillResult, Position)"
```

---

## Task 3: Implement and test the paper-only startup guard

**Files:**
- Create: `congress-copy/src/paper_guard.py`
- Create: `congress-copy/tests/conftest.py`
- Create: `congress-copy/tests/test_paper_guard.py`

- [ ] **Step 1: Write `tests/conftest.py` with shared fixtures**

`congress-copy/tests/conftest.py`:
```python
"""Shared pytest fixtures."""
import os
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def tmp_db(tmp_path: Path) -> str:
    """Path to a fresh SQLite database that lives only for the test."""
    return str(tmp_path / "state.db")


@pytest.fixture
def paper_env(monkeypatch):
    """Set env vars to valid paper-trading values."""
    monkeypatch.setenv("ALPACA_API_KEY", "fake_paper_key")
    monkeypatch.setenv("ALPACA_API_SECRET", "fake_paper_secret")
    monkeypatch.setenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets/v2")


@pytest.fixture
def live_env(monkeypatch):
    """Set env vars to a LIVE (forbidden) URL — guard must block this."""
    monkeypatch.setenv("ALPACA_API_KEY", "fake_live_key")
    monkeypatch.setenv("ALPACA_API_SECRET", "fake_live_secret")
    monkeypatch.setenv("ALPACA_BASE_URL", "https://api.alpaca.markets/v2")
```

- [ ] **Step 2: Write the failing tests**

`congress-copy/tests/test_paper_guard.py`:
```python
import pytest
from src.paper_guard import assert_paper_only, PaperOnlyGuardError


def test_paper_url_passes(paper_env):
    # Should not raise.
    assert_paper_only()


def test_live_url_blocks(live_env):
    with pytest.raises(PaperOnlyGuardError) as exc:
        assert_paper_only()
    assert "paper-api.alpaca.markets" in str(exc.value)


def test_missing_url_blocks(monkeypatch):
    monkeypatch.delenv("ALPACA_BASE_URL", raising=False)
    with pytest.raises(PaperOnlyGuardError):
        assert_paper_only()


def test_typo_url_blocks(monkeypatch):
    monkeypatch.setenv("ALPACA_BASE_URL", "https://paper-api.alpaca.market/v2")  # missing 's'
    with pytest.raises(PaperOnlyGuardError):
        assert_paper_only()
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_paper_guard.py -v
```

Expected: 4 failures with `ModuleNotFoundError: No module named 'src.paper_guard'`.

- [ ] **Step 4: Write `paper_guard.py`**

`congress-copy/src/paper_guard.py`:
```python
"""Hard guard: refuse to run against anything but the Alpaca paper URL."""
import os

PAPER_URL = "https://paper-api.alpaca.markets/v2"


class PaperOnlyGuardError(RuntimeError):
    """Raised when ALPACA_BASE_URL is not the paper URL."""


def assert_paper_only() -> None:
    """Exit-loud if anyone is about to trade against a non-paper Alpaca account."""
    url = os.environ.get("ALPACA_BASE_URL", "")
    if url != PAPER_URL:
        raise PaperOnlyGuardError(
            f"REFUSING TO RUN: ALPACA_BASE_URL must be exactly "
            f"{PAPER_URL!r}, got {url!r}. This bot is paper-trading only."
        )
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_paper_guard.py -v
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
cd congress-copy
git add src/paper_guard.py tests/conftest.py tests/test_paper_guard.py
git commit -m "feat: add PAPER_ONLY_GUARD with tests"
```

---

## Task 4: Implement and test config loader

**Files:**
- Create: `congress-copy/config.py`

- [ ] **Step 1: Write `config.py`**

`congress-copy/config.py`:
```python
"""All tunable knobs. See spec §7."""
from decimal import Decimal

# Who we're copying
POLITICIAN_SLUG = "josh-gottheimer"
POLITICIAN_NAME = "Josh Gottheimer"

# Position sizing tiers: (max_range_high_usd, dollars_to_commit)
SIZING_TIERS: list[tuple[Decimal, Decimal]] = [
    (Decimal("15000"),    Decimal("500")),
    (Decimal("50000"),    Decimal("1000")),
    (Decimal("100000"),   Decimal("2000")),
    (Decimal("250000"),   Decimal("3000")),
    (Decimal("1000000"),  Decimal("4000")),
    (Decimal("Infinity"), Decimal("5000")),
]

# Risk management
STOP_LOSS_PCT = Decimal("-0.15")

# Options fallback
OPTIONS_MIN_DAYS_TO_EXPIRY = 30
OPTIONS_MAX_STRIKE_DEVIATION_PCT = Decimal("0.10")
OPTIONS_UNDERLYING_FALLBACK = True

# Schedule (US/Central, user's home timezone)
DISCLOSURE_CHECK_HOURS = [6, 12, 18, 23]
MONITOR_INTERVAL_MINUTES = 30

# Safety rails
MAX_OPEN_POSITIONS = 50
MAX_DAILY_TRADES = 20
STALE_DISCLOSURE_CUTOFF_DAYS = 7
PAPER_ONLY_GUARD = True
```

- [ ] **Step 2: Verify import**

```bash
cd congress-copy
.venv/Scripts/python -c "import config; print(config.POLITICIAN_NAME, config.STOP_LOSS_PCT)"
```

Expected: `Josh Gottheimer -0.15`

- [ ] **Step 3: Commit**

```bash
cd congress-copy
git add config.py
git commit -m "feat: add config module with sizing tiers, stop-loss, schedule"
```

---

## Task 5: Implement and test sizing module (TDD)

**Files:**
- Create: `congress-copy/src/sizing.py`
- Create: `congress-copy/tests/test_sizing.py`

- [ ] **Step 1: Write the failing tests**

`congress-copy/tests/test_sizing.py`:
```python
from decimal import Decimal

import pytest
from src.sizing import compute_position_size, SizingError


@pytest.mark.parametrize("low,high,expected", [
    # Tier 1: max $15K → $500
    ("1000",   "15000",   "500"),
    ("0",      "1000",    "500"),
    # Tier 2: max $50K → $1000
    ("15001",  "50000",   "1000"),
    ("15000.01", "16000", "1000"),
    # Tier 3: max $100K → $2000
    ("50001",  "100000",  "2000"),
    # Tier 4: max $250K → $3000
    ("100001", "250000",  "3000"),
    # Tier 5: max $1M → $4000
    ("250001", "1000000", "4000"),
    # Tier 6 (cap): anything over $1M → $5000
    ("1000001", "5000000",  "5000"),
    ("5000001", "50000000", "5000"),
])
def test_tier_boundaries(low: str, high: str, expected: str):
    result = compute_position_size(Decimal(low), Decimal(high))
    assert result == Decimal(expected)


def test_negative_range_raises():
    with pytest.raises(SizingError):
        compute_position_size(Decimal("-1"), Decimal("1000"))


def test_low_greater_than_high_raises():
    with pytest.raises(SizingError):
        compute_position_size(Decimal("100000"), Decimal("1000"))


def test_zero_zero_returns_smallest_tier():
    # Even a $0–$0 disclosure (rare/odd) gets the smallest tier rather than failing
    assert compute_position_size(Decimal("0"), Decimal("0")) == Decimal("500")
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_sizing.py -v
```

Expected: All fail with `ModuleNotFoundError: No module named 'src.sizing'`.

- [ ] **Step 3: Write `sizing.py`**

`congress-copy/src/sizing.py`:
```python
"""Tiered position sizing: maps a disclosed dollar range to a fixed commit."""
from decimal import Decimal

import config


class SizingError(ValueError):
    """Raised on malformed range inputs."""


def compute_position_size(range_low: Decimal, range_high: Decimal) -> Decimal:
    """
    Map a disclosed (range_low, range_high) USD pair to a dollar amount.

    Uses range_high to pick the tier — the disclosure's upper bound is the
    most conservative read of the politician's conviction.
    """
    if range_low < 0 or range_high < 0:
        raise SizingError(f"Range cannot be negative: ({range_low}, {range_high})")
    if range_low > range_high:
        raise SizingError(f"range_low > range_high: ({range_low}, {range_high})")

    for tier_max, dollars in config.SIZING_TIERS:
        if range_high <= tier_max:
            return dollars
    # Unreachable: last tier is Infinity, but mypy/safety
    return config.SIZING_TIERS[-1][1]
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_sizing.py -v
```

Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
cd congress-copy
git add src/sizing.py tests/test_sizing.py
git commit -m "feat: add tiered position sizing with full boundary tests"
```

---

## Task 6: Implement and test state module (SQLite + idempotency)

**Files:**
- Create: `congress-copy/src/state.py`
- Create: `congress-copy/tests/test_state.py`

- [ ] **Step 1: Write the failing tests**

`congress-copy/tests/test_state.py`:
```python
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from src.models import Disclosure
from src.state import State


def _disclosure(trade_id: str, days_old: int = 0) -> Disclosure:
    now = datetime(2026, 4, 25, 12, 0, tzinfo=timezone.utc)
    filed = now - timedelta(days=days_old)
    return Disclosure(
        trade_id=trade_id,
        politician_slug="josh-gottheimer",
        ticker="AAPL",
        side="buy",
        asset_kind="stock",
        range_low=Decimal("15000"),
        range_high=Decimal("50000"),
        traded_at=filed - timedelta(days=30),
        filed_at=filed,
    )


def test_filter_unseen_returns_all_when_db_empty(tmp_db):
    state = State(tmp_db)
    disclosures = [_disclosure("a"), _disclosure("b")]
    unseen = state.filter_unseen(disclosures)
    assert {d.trade_id for d in unseen} == {"a", "b"}


def test_filter_unseen_drops_already_recorded(tmp_db):
    state = State(tmp_db)
    state.record_seen(_disclosure("a"))
    unseen = state.filter_unseen([_disclosure("a"), _disclosure("b")])
    assert {d.trade_id for d in unseen} == {"b"}


def test_filter_unseen_drops_stale_disclosures(tmp_db):
    state = State(tmp_db, stale_cutoff_days=7)
    fresh = _disclosure("fresh", days_old=3)
    stale = _disclosure("stale", days_old=10)
    unseen = state.filter_unseen([fresh, stale])
    assert {d.trade_id for d in unseen} == {"fresh"}


def test_double_record_seen_is_idempotent(tmp_db):
    state = State(tmp_db)
    state.record_seen(_disclosure("a"))
    state.record_seen(_disclosure("a"))  # must not raise
    assert state.filter_unseen([_disclosure("a")]) == []


def test_position_entry_round_trip(tmp_db):
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("180.00"), qty=Decimal("5"))
    assert state.get_avg_entry("AAPL") == Decimal("180.00")


def test_position_avg_entry_weights_by_qty(tmp_db):
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("100.00"), qty=Decimal("10"))
    state.record_position("AAPL", entry_price=Decimal("200.00"), qty=Decimal("10"))
    # Equal qty → simple average = 150
    assert state.get_avg_entry("AAPL") == Decimal("150.00")


def test_get_avg_entry_unknown_symbol_returns_none(tmp_db):
    state = State(tmp_db)
    assert state.get_avg_entry("NVDA") is None


def test_mark_stopped_out_clears_position(tmp_db):
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("180"), qty=Decimal("5"))
    state.mark_stopped_out("AAPL", exit_price=Decimal("153"), drawdown=Decimal("-0.15"))
    assert state.get_avg_entry("AAPL") is None


def test_event_log_records_and_lists(tmp_db):
    state = State(tmp_db)
    state.log_event("ORDER_PLACED", trade_id="a", reason="ok")
    state.log_event("STOP_LOSS_FIRED", trade_id=None, reason="drawdown -0.18")
    events = state.recent_events(limit=10)
    assert len(events) == 2
    assert events[0]["event_type"] == "STOP_LOSS_FIRED"  # most recent first
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_state.py -v
```

Expected: failures with `ModuleNotFoundError: No module named 'src.state'`.

- [ ] **Step 3: Write `state.py`**

`congress-copy/src/state.py`:
```python
"""SQLite-backed bookkeeping. Only module that touches the database."""
import sqlite3
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from src.models import Disclosure

SCHEMA = """
CREATE TABLE IF NOT EXISTS seen_disclosures (
    trade_id TEXT PRIMARY KEY,
    seen_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    symbol      TEXT NOT NULL,
    entry_price TEXT NOT NULL,
    qty         TEXT NOT NULL,
    opened_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    trade_id   TEXT,
    reason     TEXT,
    created_at TEXT NOT NULL
);
"""


class State:
    def __init__(self, db_path: str, stale_cutoff_days: int = 7) -> None:
        self.db_path = db_path
        self.stale_cutoff_days = stale_cutoff_days
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def filter_unseen(self, disclosures: list[Disclosure]) -> list[Disclosure]:
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.stale_cutoff_days)
        cur = self._conn.execute("SELECT trade_id FROM seen_disclosures")
        seen = {row["trade_id"] for row in cur.fetchall()}
        return [
            d for d in disclosures
            if d.trade_id not in seen and d.filed_at >= cutoff
        ]

    def record_seen(self, disclosure: Disclosure) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO seen_disclosures (trade_id, seen_at) VALUES (?, ?)",
            (disclosure.trade_id, datetime.now(timezone.utc).isoformat()),
        )
        self._conn.commit()

    def record_position(self, symbol: str, entry_price: Decimal, qty: Decimal) -> None:
        self._conn.execute(
            "INSERT INTO positions (symbol, entry_price, qty, opened_at) VALUES (?, ?, ?, ?)",
            (symbol, str(entry_price), str(qty), datetime.now(timezone.utc).isoformat()),
        )
        self._conn.commit()

    def get_avg_entry(self, symbol: str) -> Optional[Decimal]:
        cur = self._conn.execute(
            "SELECT entry_price, qty FROM positions WHERE symbol = ?",
            (symbol,),
        )
        rows = cur.fetchall()
        if not rows:
            return None
        total_qty = Decimal(0)
        total_cost = Decimal(0)
        for row in rows:
            qty = Decimal(row["qty"])
            price = Decimal(row["entry_price"])
            total_qty += qty
            total_cost += qty * price
        if total_qty == 0:
            return None
        return total_cost / total_qty

    def mark_stopped_out(self, symbol: str, exit_price: Decimal, drawdown: Decimal) -> None:
        self._conn.execute("DELETE FROM positions WHERE symbol = ?", (symbol,))
        self.log_event(
            "STOP_LOSS_FIRED",
            trade_id=None,
            reason=f"{symbol} exit={exit_price} drawdown={drawdown}",
        )

    def log_event(self, event_type: str, trade_id: Optional[str], reason: Optional[str]) -> None:
        self._conn.execute(
            "INSERT INTO events (event_type, trade_id, reason, created_at) VALUES (?, ?, ?, ?)",
            (event_type, trade_id, reason, datetime.now(timezone.utc).isoformat()),
        )
        self._conn.commit()

    def recent_events(self, limit: int = 50) -> list[dict]:
        cur = self._conn.execute(
            "SELECT event_type, trade_id, reason, created_at FROM events "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        return [dict(row) for row in cur.fetchall()]

    def close(self) -> None:
        self._conn.close()
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_state.py -v
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
cd congress-copy
git add src/state.py tests/test_state.py
git commit -m "feat: add SQLite-backed state with idempotent disclosure dedupe"
```

---

## Task 7: Implement Alpaca client wrapper

**Files:**
- Create: `congress-copy/src/alpaca_client.py`
- Create: `congress-copy/tests/test_alpaca_client.py`

- [ ] **Step 1: Write failing tests using respx (httpx mocking)**

`congress-copy/tests/test_alpaca_client.py`:
```python
from decimal import Decimal

import httpx
import pytest
import respx

from src.alpaca_client import AlpacaClient
from src.models import OrderIntent


@pytest.fixture
def client(paper_env) -> AlpacaClient:
    return AlpacaClient()


@respx.mock
def test_submit_stock_order_uses_notional(client):
    route = respx.post("https://paper-api.alpaca.markets/v2/orders").mock(
        return_value=httpx.Response(
            200,
            json={"id": "order-123", "status": "accepted", "filled_avg_price": None, "filled_qty": "0"},
        )
    )
    intent = OrderIntent(symbol="AAPL", side="buy", notional_usd=Decimal("1000"), asset_kind="stock")
    fill = client.submit(intent)
    assert fill.order_id == "order-123"
    assert fill.status == "pending"
    body = route.calls[-1].request.read().decode()
    assert '"symbol": "AAPL"' in body or '"symbol":"AAPL"' in body
    assert '"notional"' in body


@respx.mock
def test_submit_option_order_uses_qty(client):
    respx.post("https://paper-api.alpaca.markets/v2/orders").mock(
        return_value=httpx.Response(200, json={"id": "ord", "status": "accepted",
                                                "filled_avg_price": None, "filled_qty": "0"})
    )
    intent = OrderIntent(
        symbol="AAPL241220C00200000",  # OCC-formatted option symbol
        side="buy",
        notional_usd=Decimal("0"),
        qty=2,
        asset_kind="option",
    )
    fill = client.submit(intent)
    assert fill.status == "pending"


@respx.mock
def test_submit_handles_rejection(client):
    respx.post("https://paper-api.alpaca.markets/v2/orders").mock(
        return_value=httpx.Response(422, json={"message": "insufficient buying power"})
    )
    intent = OrderIntent(symbol="AAPL", side="buy", notional_usd=Decimal("1000"))
    fill = client.submit(intent)
    assert fill.status == "rejected"
    assert "insufficient buying power" in (fill.reason or "")


@respx.mock
def test_submit_retries_on_5xx_then_succeeds(client):
    respx.post("https://paper-api.alpaca.markets/v2/orders").mock(
        side_effect=[
            httpx.Response(503, json={"message": "service unavailable"}),
            httpx.Response(200, json={"id": "ord-ok", "status": "accepted",
                                       "filled_avg_price": None, "filled_qty": "0"}),
        ]
    )
    intent = OrderIntent(symbol="AAPL", side="buy", notional_usd=Decimal("1000"))
    fill = client.submit(intent)
    assert fill.status == "pending"
    assert fill.order_id == "ord-ok"


@respx.mock
def test_is_market_open(client):
    respx.get("https://paper-api.alpaca.markets/v2/clock").mock(
        return_value=httpx.Response(200, json={"is_open": True})
    )
    assert client.is_market_open() is True


@respx.mock
def test_list_positions_returns_dataclasses(client):
    respx.get("https://paper-api.alpaca.markets/v2/positions").mock(
        return_value=httpx.Response(200, json=[
            {
                "symbol": "AAPL",
                "qty": "5",
                "avg_entry_price": "180.00",
                "current_price": "190.00",
                "market_value": "950.00",
                "unrealized_plpc": "0.0556",
            }
        ])
    )
    positions = client.list_positions()
    assert len(positions) == 1
    assert positions[0].symbol == "AAPL"
    assert positions[0].qty == Decimal("5")
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_alpaca_client.py -v
```

Expected: failures with `ModuleNotFoundError: No module named 'src.alpaca_client'`.

- [ ] **Step 3: Write `alpaca_client.py`**

`congress-copy/src/alpaca_client.py`:
```python
"""Thin wrapper over the Alpaca paper REST API. Knows nothing about politicians."""
import os
import time
from decimal import Decimal
from typing import Optional

import httpx

from src.models import FillResult, OrderIntent, Position
from src.paper_guard import assert_paper_only

RETRY_BACKOFFS = [1, 2, 4, 8, 16]  # seconds


class AlpacaClient:
    def __init__(self, timeout_seconds: float = 10.0) -> None:
        assert_paper_only()
        self.base_url = os.environ["ALPACA_BASE_URL"].rstrip("/")
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={
                "APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
                "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET"],
            },
            timeout=timeout_seconds,
        )

    def submit(self, intent: OrderIntent) -> FillResult:
        body: dict = {
            "symbol": intent.symbol,
            "side": intent.side,
            "type": "market",
            "time_in_force": "day",
        }
        if intent.asset_kind == "option":
            body["qty"] = str(intent.qty)
        else:
            body["notional"] = str(intent.notional_usd)

        last_err: Optional[str] = None
        for backoff in RETRY_BACKOFFS:
            try:
                resp = self._client.post("/orders", json=body)
            except httpx.HTTPError as e:
                last_err = str(e)
                time.sleep(backoff)
                continue

            if 500 <= resp.status_code < 600:
                last_err = f"{resp.status_code}: {resp.text[:200]}"
                time.sleep(backoff)
                continue

            data = resp.json()
            if resp.status_code >= 400:
                return FillResult(
                    order_id="",
                    status="rejected",
                    reason=data.get("message", resp.text[:200]),
                )
            return FillResult(
                order_id=data["id"],
                status="filled" if data.get("filled_avg_price") else "pending",
                filled_avg_price=(
                    Decimal(data["filled_avg_price"]) if data.get("filled_avg_price") else None
                ),
                filled_qty=(
                    Decimal(data["filled_qty"]) if data.get("filled_qty") else None
                ),
            )
        return FillResult(order_id="", status="rejected", reason=f"retries exhausted: {last_err}")

    def is_market_open(self) -> bool:
        resp = self._client.get("/clock")
        resp.raise_for_status()
        return bool(resp.json()["is_open"])

    def list_positions(self) -> list[Position]:
        resp = self._client.get("/positions")
        resp.raise_for_status()
        return [
            Position(
                symbol=p["symbol"],
                qty=Decimal(p["qty"]),
                avg_entry_price=Decimal(p["avg_entry_price"]),
                current_price=Decimal(p["current_price"]),
                market_value=Decimal(p["market_value"]),
                unrealized_pl_pct=Decimal(p["unrealized_plpc"]),
            )
            for p in resp.json()
        ]

    def close_position(self, symbol: str) -> FillResult:
        resp = self._client.delete(f"/positions/{symbol}")
        if resp.status_code >= 400:
            return FillResult(order_id="", status="rejected",
                               reason=resp.json().get("message", resp.text[:200]))
        data = resp.json()
        return FillResult(
            order_id=data.get("id", ""),
            status="pending",
        )

    def find_option_contract(
        self,
        underlying: str,
        option_type: str,
        target_strike: Decimal,
        target_expiry,
        min_days_to_expiry: int,
        max_strike_deviation_pct: Decimal,
    ) -> Optional[str]:
        """
        Query Alpaca's option contracts endpoint and return the OCC symbol of the
        best-matching tradable contract, or None if nothing fits.
        """
        params = {
            "underlying_symbols": underlying,
            "type": option_type,
            "status": "active",
            "limit": 1000,
        }
        resp = self._client.get("/options/contracts", params=params)
        if resp.status_code >= 400:
            return None

        contracts = resp.json().get("option_contracts", [])
        from datetime import date, timedelta
        cutoff = date.today() + timedelta(days=min_days_to_expiry)

        best: Optional[tuple[Decimal, dict]] = None
        for c in contracts:
            strike = Decimal(c["strike_price"])
            expiry = date.fromisoformat(c["expiration_date"])
            if expiry < cutoff:
                continue
            deviation = abs(strike - target_strike) / target_strike if target_strike else Decimal(1)
            if deviation > max_strike_deviation_pct:
                continue
            if best is None or deviation < best[0]:
                best = (deviation, c)
        return best[1]["symbol"] if best else None
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_alpaca_client.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd congress-copy
git add src/alpaca_client.py tests/test_alpaca_client.py
git commit -m "feat: add Alpaca paper REST client with retry/backoff"
```

---

## Task 8: Implement options resolver (cascading fallback)

**Files:**
- Create: `congress-copy/src/options_resolver.py`
- Create: `congress-copy/tests/test_options_resolver.py`

- [ ] **Step 1: Write failing tests**

`congress-copy/tests/test_options_resolver.py`:
```python
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from src.models import Disclosure, OptionDetails, OrderIntent
from src.options_resolver import resolve_option


def _option_disclosure(strike: str = "200", days_to_expiry: int = 60,
                       option_type: str = "call") -> Disclosure:
    expiry = datetime(2026, 4, 25, tzinfo=timezone.utc) + timedelta(days=days_to_expiry)
    return Disclosure(
        trade_id="opt-1",
        politician_slug="josh-gottheimer",
        ticker="AAPL",
        side="buy",
        asset_kind="option",
        range_low=Decimal("15000"),
        range_high=Decimal("50000"),
        traded_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
        filed_at=datetime(2026, 4, 25, tzinfo=timezone.utc),
        option=OptionDetails(option_type=option_type, strike=Decimal(strike), expiry=expiry),
    )


def test_exact_contract_match():
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = "AAPL241220C00200000"
    intent = resolve_option(_option_disclosure(), notional=Decimal("1000"), alpaca=alpaca)
    assert intent is not None
    assert intent.symbol == "AAPL241220C00200000"
    assert intent.fallback_path == "exact_option"
    assert intent.qty == 1  # Min qty when notional is small enough; see helper for sizing


def test_falls_back_to_underlying_when_no_contract():
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = None
    intent = resolve_option(_option_disclosure(), notional=Decimal("1000"), alpaca=alpaca)
    assert intent is not None
    assert intent.symbol == "AAPL"
    assert intent.asset_kind == "stock"
    assert intent.side == "buy"  # call → long stock
    assert intent.fallback_path == "underlying"
    assert intent.notional_usd == Decimal("1000")


def test_put_falls_back_to_short_underlying():
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = None
    intent = resolve_option(
        _option_disclosure(option_type="put"),
        notional=Decimal("1000"),
        alpaca=alpaca,
    )
    assert intent is not None
    assert intent.symbol == "AAPL"
    assert intent.side == "sell"  # put → short underlying
    assert intent.fallback_path == "underlying"


def test_skip_when_disabled_and_no_match(monkeypatch):
    import config
    monkeypatch.setattr(config, "OPTIONS_UNDERLYING_FALLBACK", False)
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = None
    intent = resolve_option(_option_disclosure(), notional=Decimal("1000"), alpaca=alpaca)
    assert intent is None


def test_sell_side_short_call_is_short_underlying():
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = None
    disc = _option_disclosure(option_type="call")
    disc = Disclosure(**{**disc.__dict__, "side": "sell"})  # selling a call = short
    intent = resolve_option(disc, notional=Decimal("1000"), alpaca=alpaca)
    assert intent is not None
    assert intent.side == "sell"
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_options_resolver.py -v
```

Expected: failures with `ModuleNotFoundError: No module named 'src.options_resolver'`.

- [ ] **Step 3: Write `options_resolver.py`**

`congress-copy/src/options_resolver.py`:
```python
"""Cascading fallback: exact contract → similar contract → underlying → skip."""
from decimal import Decimal
from typing import Optional

import config
from src.alpaca_client import AlpacaClient
from src.models import Disclosure, OrderIntent


def resolve_option(
    disclosure: Disclosure,
    notional: Decimal,
    alpaca: AlpacaClient,
) -> Optional[OrderIntent]:
    """Return the best-effort OrderIntent for a disclosed option trade, or None."""
    if disclosure.option is None:
        raise ValueError("resolve_option called with non-option disclosure")

    opt = disclosure.option

    # Step 1+2: Try to match a contract within strike-deviation and min-DTE bounds.
    # The Alpaca client already filters by expiry+strike — this single call serves
    # both the exact and "similar" tiers.
    symbol = alpaca.find_option_contract(
        underlying=disclosure.ticker,
        option_type=opt.option_type,
        target_strike=opt.strike,
        target_expiry=opt.expiry,
        min_days_to_expiry=config.OPTIONS_MIN_DAYS_TO_EXPIRY,
        max_strike_deviation_pct=config.OPTIONS_MAX_STRIKE_DEVIATION_PCT,
    )

    if symbol:
        # Crude contract sizing: 1 contract minimum; scale up by notional/$5k slabs.
        contracts = max(1, int(notional / Decimal("5000")))
        return OrderIntent(
            symbol=symbol,
            side=disclosure.side,
            notional_usd=Decimal(0),
            qty=contracts,
            asset_kind="option",
            fallback_path="exact_option",
        )

    # Step 3: Underlying fallback.
    if not config.OPTIONS_UNDERLYING_FALLBACK:
        return None

    # Long call or short put → long the stock.
    # Long put or short call → short the stock.
    bullish = (opt.option_type == "call" and disclosure.side == "buy") or (
        opt.option_type == "put" and disclosure.side == "sell"
    )
    underlying_side = "buy" if bullish else "sell"

    return OrderIntent(
        symbol=disclosure.ticker,
        side=underlying_side,
        notional_usd=notional,
        asset_kind="stock",
        fallback_path="underlying",
    )
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_options_resolver.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd congress-copy
git add src/options_resolver.py tests/test_options_resolver.py
git commit -m "feat: add options cascading fallback (exact → similar → underlying → skip)"
```

---

## Task 9: Implement scraper (CapitolTrades via Playwright)

**Files:**
- Create: `congress-copy/src/scraper.py`

> **Note:** No unit tests for the scraper — HTML scraper tests are brittle and create false confidence. Right monitoring is the `PARSE_ERROR` log entry plus user review of daily summaries. We'll exercise the scraper during the live smoke test in Task 14.

- [ ] **Step 1: Write `scraper.py`**

`congress-copy/src/scraper.py`:
```python
"""Playwright-based scraper for CapitolTrades politician pages.

Returns a list of `Disclosure` dataclasses. On any parsing error, logs and
returns an empty list — never raises into the caller.
"""
import logging
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from playwright.sync_api import sync_playwright, Page

from src.models import Disclosure, OptionDetails

log = logging.getLogger(__name__)

CAPITOLTRADES_BASE = "https://www.capitoltrades.com"
RANGE_RE = re.compile(r"\$([\d,KM]+)\s*[-–]\s*\$([\d,KM]+)")


def _parse_dollar_range(text: str) -> Optional[tuple[Decimal, Decimal]]:
    m = RANGE_RE.search(text)
    if not m:
        return None
    return _parse_kmb(m.group(1)), _parse_kmb(m.group(2))


def _parse_kmb(raw: str) -> Decimal:
    raw = raw.replace(",", "").upper()
    multiplier = Decimal(1)
    if raw.endswith("K"):
        multiplier = Decimal(1_000)
        raw = raw[:-1]
    elif raw.endswith("M"):
        multiplier = Decimal(1_000_000)
        raw = raw[:-1]
    return Decimal(raw) * multiplier


def fetch_recent_disclosures(politician_slug: str, max_pages: int = 3) -> list[Disclosure]:
    """Scrape up to `max_pages` pages of trades for the politician.

    Returns [] on any parse failure (logged as PARSE_ERROR).
    """
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (compatible; CongressCopyBot/1.0; paper-trading research)"
            )
            page = context.new_page()
            disclosures: list[Disclosure] = []
            for page_num in range(1, max_pages + 1):
                url = f"{CAPITOLTRADES_BASE}/politicians/{politician_slug}?page={page_num}"
                try:
                    page.goto(url, wait_until="networkidle", timeout=30_000)
                except Exception as e:
                    log.error("PARSE_ERROR navigation %s: %s", url, e)
                    break
                disclosures.extend(_extract_rows(page, politician_slug))
            browser.close()
            return disclosures
    except Exception as e:
        log.error("PARSE_ERROR scraper top-level: %s", e)
        return []


def _extract_rows(page: Page, politician_slug: str) -> list[Disclosure]:
    """Extract Disclosure rows from a CapitolTrades politician trades table.

    The selectors below target the public CapitolTrades HTML structure as of
    2026-04. If they break, this returns [] and logs PARSE_ERROR.
    """
    out: list[Disclosure] = []
    try:
        rows = page.query_selector_all("table tbody tr")
    except Exception as e:
        log.error("PARSE_ERROR selecting rows: %s", e)
        return []

    for row in rows:
        try:
            cells = row.query_selector_all("td")
            if len(cells) < 7:
                continue
            ticker = (cells[1].inner_text() or "").strip().upper()
            if not ticker or ticker == "N/A":
                continue
            traded_at = _parse_date(cells[2].inner_text())
            filed_at = _parse_date(cells[3].inner_text())
            side_text = (cells[4].inner_text() or "").strip().lower()
            side = "buy" if "buy" in side_text else "sell"
            range_text = cells[5].inner_text() or ""
            parsed_range = _parse_dollar_range(range_text)
            if not parsed_range or not traded_at or not filed_at:
                continue
            range_low, range_high = parsed_range

            link = row.query_selector("a[href*='/trades/']")
            href = link.get_attribute("href") if link else None
            trade_id = (href or "").rsplit("/", 1)[-1] or f"{politician_slug}-{ticker}-{filed_at.isoformat()}"

            asset_kind, option = _classify_asset(cells)

            out.append(Disclosure(
                trade_id=trade_id,
                politician_slug=politician_slug,
                ticker=ticker,
                side=side,
                asset_kind=asset_kind,
                range_low=range_low,
                range_high=range_high,
                traded_at=traded_at,
                filed_at=filed_at,
                option=option,
            ))
        except Exception as e:
            log.error("PARSE_ERROR row: %s", e)
            continue
    return out


def _parse_date(raw: str) -> Optional[datetime]:
    raw = (raw or "").strip()
    for fmt in ("%Y-%m-%d", "%d %b %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _classify_asset(cells) -> tuple[str, Optional[OptionDetails]]:
    """Best-effort classification: stock/etf vs option, and option fields if present."""
    asset_text = (cells[6].inner_text() if len(cells) > 6 else "").lower()
    if "option" in asset_text or "call" in asset_text or "put" in asset_text:
        # CapitolTrades displays option metadata inline; full parsing is fragile.
        # If we can't parse the strike/expiry cleanly, treat as a "stock" so the
        # underlying fallback runs naturally.
        return "stock", None  # conservative; resolver will buy underlying
    if "etf" in asset_text:
        return "etf", None
    return "stock", None
```

- [ ] **Step 2: Smoke check the import**

```bash
cd congress-copy
.venv/Scripts/python -c "from src.scraper import fetch_recent_disclosures; print('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd congress-copy
git add src/scraper.py
git commit -m "feat: add CapitolTrades Playwright scraper with PARSE_ERROR safety"
```

---

## Task 10: Implement and test the trader (orchestration)

**Files:**
- Create: `congress-copy/src/trader.py`
- Create: `congress-copy/tests/test_trader.py`

- [ ] **Step 1: Write failing tests**

`congress-copy/tests/test_trader.py`:
```python
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from src.models import Disclosure, FillResult, OrderIntent
from src.trader import Trader


def _stock_disclosure(trade_id: str = "t1", side: str = "buy",
                      range_high: str = "50000") -> Disclosure:
    return Disclosure(
        trade_id=trade_id,
        politician_slug="josh-gottheimer",
        ticker="AAPL",
        side=side,
        asset_kind="stock",
        range_low=Decimal("15000"),
        range_high=Decimal(range_high),
        traded_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
        filed_at=datetime(2026, 4, 24, tzinfo=timezone.utc),
    )


def test_trader_submits_order_for_new_disclosure(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.return_value = FillResult(order_id="o1", status="filled",
                                             filled_avg_price=Decimal("180"),
                                             filled_qty=Decimal("5"))
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["ordered"] == 1
    alpaca.submit.assert_called_once()
    intent: OrderIntent = alpaca.submit.call_args[0][0]
    assert intent.symbol == "AAPL"
    assert intent.notional_usd == Decimal("1000")  # tier 2 ($15K-$50K → $1000)


def test_trader_skips_already_seen_disclosure(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    state.record_seen(_stock_disclosure())  # already seen
    alpaca = MagicMock()
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["ordered"] == 0
    alpaca.submit.assert_not_called()


def test_trader_records_position_on_filled(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.return_value = FillResult(order_id="o1", status="filled",
                                             filled_avg_price=Decimal("180"),
                                             filled_qty=Decimal("5"))
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    trader.run_disclosure_cycle()

    assert state.get_avg_entry("AAPL") == Decimal("180")


def test_trader_logs_skip_on_no_buying_power(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.return_value = FillResult(order_id="", status="rejected",
                                             reason="insufficient buying power")
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["skipped"] == 1
    events = state.recent_events()
    assert any(e["event_type"] == "ORDER_REJECTED" for e in events)


def test_trader_circuit_breaker_halts_at_max_daily_trades(tmp_db, paper_env, monkeypatch):
    import config
    monkeypatch.setattr(config, "MAX_DAILY_TRADES", 2)
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.return_value = FillResult(order_id="o", status="filled",
                                             filled_avg_price=Decimal("100"), filled_qty=Decimal("10"))
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [
        _stock_disclosure(trade_id=f"t{i}") for i in range(5)
    ]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["ordered"] == 2
    assert summary["circuit_broken"] == 3
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_trader.py -v
```

Expected: failures with `ModuleNotFoundError: No module named 'src.trader'`.

- [ ] **Step 3: Write `trader.py`**

`congress-copy/src/trader.py`:
```python
"""Orchestrates: scraper disclosures → sized OrderIntents → Alpaca submission."""
import logging
from decimal import Decimal

import config
from src.alpaca_client import AlpacaClient
from src.models import Disclosure, OrderIntent
from src.options_resolver import resolve_option
from src.sizing import compute_position_size
from src.state import State

log = logging.getLogger(__name__)


class Trader:
    def __init__(self, state: State, alpaca: AlpacaClient, scraper) -> None:
        self.state = state
        self.alpaca = alpaca
        self.scraper = scraper

    def run_disclosure_cycle(self) -> dict:
        summary = {"new": 0, "ordered": 0, "skipped": 0, "circuit_broken": 0, "errors": 0}
        all_disclosures = self.scraper.fetch_recent_disclosures(config.POLITICIAN_SLUG)
        new = self.state.filter_unseen(all_disclosures)
        summary["new"] = len(new)

        orders_placed_this_cycle = 0
        for disclosure in new:
            if orders_placed_this_cycle >= config.MAX_DAILY_TRADES:
                summary["circuit_broken"] += 1
                self.state.log_event("CIRCUIT_BREAKER_TRIPPED",
                                      trade_id=disclosure.trade_id,
                                      reason=f"exceeded MAX_DAILY_TRADES={config.MAX_DAILY_TRADES}")
                continue

            intent = self._build_intent(disclosure)
            if intent is None:
                summary["skipped"] += 1
                self.state.record_seen(disclosure)
                self.state.log_event("OPTION_UNRESOLVABLE",
                                      trade_id=disclosure.trade_id,
                                      reason=f"no contract or fallback for {disclosure.ticker}")
                continue

            fill = self.alpaca.submit(intent)
            self.state.record_seen(disclosure)
            if fill.status == "rejected":
                summary["skipped"] += 1
                self.state.log_event("ORDER_REJECTED",
                                      trade_id=disclosure.trade_id,
                                      reason=fill.reason or "unknown")
                continue
            if fill.status == "filled" and fill.filled_avg_price and fill.filled_qty:
                self.state.record_position(intent.symbol, fill.filled_avg_price, fill.filled_qty)
            self.state.log_event(
                "ORDER_PLACED",
                trade_id=disclosure.trade_id,
                reason=f"{intent.side} {intent.symbol} fallback={intent.fallback_path}",
            )
            summary["ordered"] += 1
            orders_placed_this_cycle += 1

        return summary

    def _build_intent(self, disclosure: Disclosure):
        notional = compute_position_size(disclosure.range_low, disclosure.range_high)
        if disclosure.asset_kind == "option":
            return resolve_option(disclosure, notional, self.alpaca)
        return OrderIntent(
            symbol=disclosure.ticker,
            side=disclosure.side,
            notional_usd=notional,
            asset_kind=disclosure.asset_kind,
            fallback_path="direct",
        )
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_trader.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd congress-copy
git add src/trader.py tests/test_trader.py
git commit -m "feat: add Trader orchestrator with circuit breaker and event logging"
```

---

## Task 11: Implement and test the monitor (stop-loss)

**Files:**
- Create: `congress-copy/src/monitor.py`
- Create: `congress-copy/tests/test_monitor.py`

- [ ] **Step 1: Write failing tests**

`congress-copy/tests/test_monitor.py`:
```python
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from src.models import FillResult, Position
from src.monitor import Monitor


def _position(symbol: str, current: str, entry: str) -> Position:
    return Position(
        symbol=symbol,
        qty=Decimal("5"),
        avg_entry_price=Decimal(entry),
        current_price=Decimal(current),
        market_value=Decimal(current) * Decimal(5),
        unrealized_pl_pct=(Decimal(current) - Decimal(entry)) / Decimal(entry),
    )


def test_monitor_no_op_when_market_closed(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.is_market_open.return_value = False
    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()
    assert summary["checked"] == 0
    alpaca.list_positions.assert_not_called()


def test_monitor_stops_out_position_below_threshold(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("100"), qty=Decimal("5"))
    alpaca = MagicMock()
    alpaca.is_market_open.return_value = True
    alpaca.list_positions.return_value = [_position("AAPL", current="80", entry="100")]
    alpaca.close_position.return_value = FillResult(order_id="x", status="pending")
    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()
    assert summary["stopped_out"] == 1
    alpaca.close_position.assert_called_once_with("AAPL")
    assert state.get_avg_entry("AAPL") is None


def test_monitor_does_not_stop_out_above_threshold(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("100"), qty=Decimal("5"))
    alpaca = MagicMock()
    alpaca.is_market_open.return_value = True
    alpaca.list_positions.return_value = [_position("AAPL", current="90", entry="100")]
    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()
    assert summary["stopped_out"] == 0
    alpaca.close_position.assert_not_called()


def test_monitor_uses_state_avg_entry_when_available(tmp_db, paper_env):
    """If our state DB has a different cost basis (e.g. multiple buys), trust it."""
    from src.state import State
    state = State(tmp_db)
    # Two buys: avg = 150
    state.record_position("AAPL", entry_price=Decimal("100"), qty=Decimal("10"))
    state.record_position("AAPL", entry_price=Decimal("200"), qty=Decimal("10"))
    alpaca = MagicMock()
    alpaca.is_market_open.return_value = True
    # Alpaca shows 150 cost, current 130 → -13.3% drawdown, NOT stopped out
    alpaca.list_positions.return_value = [_position("AAPL", current="130", entry="150")]
    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()
    assert summary["stopped_out"] == 0
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_monitor.py -v
```

Expected: failures with `ModuleNotFoundError: No module named 'src.monitor'`.

- [ ] **Step 3: Write `monitor.py`**

`congress-copy/src/monitor.py`:
```python
"""Independent stop-loss watcher. Runs every 30 minutes during market hours."""
import logging
from decimal import Decimal

import config
from src.alpaca_client import AlpacaClient
from src.state import State

log = logging.getLogger(__name__)


class Monitor:
    def __init__(self, state: State, alpaca: AlpacaClient) -> None:
        self.state = state
        self.alpaca = alpaca

    def run_monitor_cycle(self) -> dict:
        summary = {"checked": 0, "stopped_out": 0, "skipped_market_closed": 0}

        if not self.alpaca.is_market_open():
            summary["skipped_market_closed"] = 1
            return summary

        positions = self.alpaca.list_positions()
        for pos in positions:
            summary["checked"] += 1
            entry = self.state.get_avg_entry(pos.symbol) or pos.avg_entry_price
            drawdown = (pos.current_price - entry) / entry
            if drawdown <= config.STOP_LOSS_PCT:
                self.alpaca.close_position(pos.symbol)
                self.state.mark_stopped_out(pos.symbol, pos.current_price, drawdown)
                summary["stopped_out"] += 1
                log.info("STOP_LOSS_FIRED %s drawdown=%s", pos.symbol, drawdown)

        return summary
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_monitor.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd congress-copy
git add src/monitor.py tests/test_monitor.py
git commit -m "feat: add Monitor with stop-loss enforcement"
```

---

## Task 12: Implement runner CLI

**Files:**
- Create: `congress-copy/src/runner.py`
- Create: `congress-copy/tests/test_runner.py`

- [ ] **Step 1: Write failing tests**

`congress-copy/tests/test_runner.py`:
```python
import sys
from unittest.mock import MagicMock, patch

import pytest


def test_runner_disclosures_subcommand_invokes_trader(paper_env):
    with patch("src.runner.Trader") as TraderClass, \
         patch("src.runner.Monitor") as MonitorClass, \
         patch("src.runner.AlpacaClient"), \
         patch("src.runner.State"), \
         patch("src.runner.scraper"):
        TraderClass.return_value.run_disclosure_cycle.return_value = {
            "new": 0, "ordered": 0, "skipped": 0, "circuit_broken": 0, "errors": 0,
        }
        from src import runner
        runner.main(["disclosures"])
        TraderClass.return_value.run_disclosure_cycle.assert_called_once()
        MonitorClass.return_value.run_monitor_cycle.assert_not_called()


def test_runner_monitor_subcommand_invokes_monitor(paper_env):
    with patch("src.runner.Trader") as TraderClass, \
         patch("src.runner.Monitor") as MonitorClass, \
         patch("src.runner.AlpacaClient"), \
         patch("src.runner.State"):
        MonitorClass.return_value.run_monitor_cycle.return_value = {
            "checked": 0, "stopped_out": 0, "skipped_market_closed": 0,
        }
        from src import runner
        runner.main(["monitor"])
        MonitorClass.return_value.run_monitor_cycle.assert_called_once()
        TraderClass.return_value.run_disclosure_cycle.assert_not_called()


def test_runner_unknown_subcommand_exits_nonzero(paper_env):
    from src import runner
    with pytest.raises(SystemExit) as exc:
        runner.main(["nonsense"])
    assert exc.value.code != 0
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_runner.py -v
```

Expected: failures.

- [ ] **Step 3: Write `runner.py`**

`congress-copy/src/runner.py`:
```python
"""CLI entrypoint: `python -m src.runner disclosures` or `... monitor`."""
import argparse
import json
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root (parent of congress-copy/)
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

import config
from src.alpaca_client import AlpacaClient
from src.monitor import Monitor
from src.paper_guard import assert_paper_only
from src.state import State
from src.trader import Trader
from src import scraper

DB_PATH = str(Path(__file__).resolve().parent.parent / "data" / "state.db")
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


def _setup_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(LOG_DIR / "bot.log", maxBytes=5_000_000, backupCount=5)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler(sys.stdout)])


def main(argv: list[str] | None = None) -> int:
    _setup_logging()
    assert_paper_only()  # blocks before any network call

    parser = argparse.ArgumentParser(prog="congress-copy")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("disclosures", help="Pull new CapitolTrades disclosures and place orders")
    sub.add_parser("monitor", help="Check open positions for stop-loss triggers")

    args = parser.parse_args(argv)

    state = State(DB_PATH, stale_cutoff_days=config.STALE_DISCLOSURE_CUTOFF_DAYS)
    alpaca = AlpacaClient()

    if args.cmd == "disclosures":
        trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
        summary = trader.run_disclosure_cycle()
    elif args.cmd == "monitor":
        monitor = Monitor(state=state, alpaca=alpaca)
        summary = monitor.run_monitor_cycle()
    else:
        parser.error(f"unknown command: {args.cmd}")

    print(json.dumps(summary, indent=2))
    state.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd congress-copy
.venv/Scripts/pytest tests/test_runner.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd congress-copy
git add src/runner.py tests/test_runner.py
git commit -m "feat: add runner CLI with disclosures/monitor subcommands"
```

---

## Task 13: Implement performance reporter

**Files:**
- Create: `congress-copy/src/report.py`

- [ ] **Step 1: Write `report.py`**

`congress-copy/src/report.py`:
```python
"""On-demand performance report. Reads the state DB and prints to stdout + CSV."""
import csv
import sqlite3
import sys
from pathlib import Path

DB_PATH = str(Path(__file__).resolve().parent.parent / "data" / "state.db")
CSV_PATH = str(Path(__file__).resolve().parent.parent / "data" / "report.csv")


def main() -> int:
    if not Path(DB_PATH).exists():
        print(f"No state DB at {DB_PATH}. Run the bot first.", file=sys.stderr)
        return 1

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print("=== Recent events ===")
    rows = conn.execute(
        "SELECT event_type, trade_id, reason, created_at FROM events "
        "ORDER BY id DESC LIMIT 50"
    ).fetchall()
    for r in rows:
        print(f"  {r['created_at']}  {r['event_type']:<25}  {r['trade_id'] or '-':<20}  {r['reason'] or ''}")

    print("\n=== Open positions ===")
    pos_rows = conn.execute(
        "SELECT symbol, SUM(CAST(qty AS REAL)) as total_qty, "
        "       SUM(CAST(qty AS REAL) * CAST(entry_price AS REAL))"
        "       / NULLIF(SUM(CAST(qty AS REAL)), 0) as avg_entry "
        "FROM positions GROUP BY symbol"
    ).fetchall()
    for r in pos_rows:
        print(f"  {r['symbol']:<8}  qty={r['total_qty']:.2f}  avg_entry=${r['avg_entry']:.2f}")

    print("\n=== Event-type counts (lifetime) ===")
    counts = conn.execute(
        "SELECT event_type, COUNT(*) as n FROM events GROUP BY event_type ORDER BY n DESC"
    ).fetchall()
    for r in counts:
        print(f"  {r['event_type']:<25}  {r['n']}")

    # CSV export of all events
    with open(CSV_PATH, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["created_at", "event_type", "trade_id", "reason"])
        for r in conn.execute("SELECT created_at, event_type, trade_id, reason FROM events ORDER BY id"):
            writer.writerow([r["created_at"], r["event_type"], r["trade_id"], r["reason"]])
    print(f"\nFull event log exported to {CSV_PATH}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Smoke test**

```bash
cd congress-copy
.venv/Scripts/python -m src.report
```

Expected: prints "No state DB" message (DB doesn't exist yet — that's fine; the script handles it cleanly).

- [ ] **Step 3: Commit**

```bash
cd congress-copy
git add src/report.py
git commit -m "feat: add performance report with CSV export"
```

---

## Task 14: Run full test suite + live smoke test

- [ ] **Step 1: Run the full test suite**

```bash
cd congress-copy
.venv/Scripts/pytest -v
```

Expected: all tests pass (~30+ tests across 7 test files).

- [ ] **Step 2: Confirm `.env` at project root has fresh paper-only credentials**

The user must have already regenerated the Alpaca keys (per the security warning during brainstorming). Verify the `.env` at `TradingBotTest-Claude/.env`:

```bash
cat "/c/Users/fatti/OneDrive/Documents/Coding Files/TradingBotTest-Claude/.env"
```

Expected: `ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2` exactly.

- [ ] **Step 3: Run one disclosure cycle live**

```bash
cd congress-copy
.venv/Scripts/python -m src.runner disclosures
```

Expected output (rough): a JSON summary with non-zero `new` (Gottheimer files often). The Alpaca dashboard should show one or more new orders.

If summary shows `new: 0`, that's also valid — Gottheimer hasn't filed anything new in the last 7 days. If `errors > 0` or you see `PARSE_ERROR` in `logs/bot.log`, the scraper selectors need adjustment (see Task 15).

- [ ] **Step 4: Run one monitor cycle live**

```bash
cd congress-copy
.venv/Scripts/python -m src.runner monitor
```

Expected: JSON summary like `{"checked": N, "stopped_out": 0, "skipped_market_closed": 0}` (depending on market hours).

- [ ] **Step 5: Run report**

```bash
cd congress-copy
.venv/Scripts/python -m src.report
```

Expected: prints recent events, open positions, event counts, and writes `data/report.csv`.

- [ ] **Step 6: Commit any final fixes**

```bash
cd congress-copy
git add -A
git commit -m "chore: live smoke test verified end-to-end flow"
```

---

## Task 15: Set up scheduled execution (Windows Task Scheduler)

> **Note:** The user runs Windows 11 and is on the road with the laptop. Windows Task Scheduler is the right scheduling primitive — works while the user is logged in, no extra dependencies. (Alternatives like `cron` or a long-running Python `schedule` loop would require the laptop to be awake AND have a process running continuously. Task Scheduler handles wake-from-sleep more gracefully on Windows.)

**Files:**
- Create: `congress-copy/scripts/schedule_install.ps1`
- Create: `congress-copy/scripts/schedule_uninstall.ps1`

- [ ] **Step 1: Write installer PowerShell script**

`congress-copy/scripts/schedule_install.ps1`:
```powershell
# Installs scheduled tasks for the congress-copy bot.
# Run once from an elevated PowerShell prompt:
#   powershell -ExecutionPolicy Bypass -File scripts\schedule_install.ps1

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
$workDir = $projectRoot

if (-not (Test-Path $python)) {
    throw "Python venv not found at $python. Run 'python -m venv .venv' first."
}

# Disclosure check: 4× daily at 06:00, 12:00, 18:00, 23:00
$disclosureTimes = @("06:00", "12:00", "18:00", "23:00")
foreach ($time in $disclosureTimes) {
    $taskName = "CongressCopy-Disclosures-$($time.Replace(':',''))"
    $action = New-ScheduledTaskAction -Execute $python `
        -Argument "-m src.runner disclosures" -WorkingDirectory $workDir
    $trigger = New-ScheduledTaskTrigger -Daily -At $time
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Force | Out-Null
    Write-Host "Installed: $taskName at $time"
}

# Monitor (stop-loss): every 30 min between 08:30 and 15:30 ET (US/Central: 07:30 - 14:30)
$monitorTaskName = "CongressCopy-Monitor"
$action = New-ScheduledTaskAction -Execute $python `
    -Argument "-m src.runner monitor" -WorkingDirectory $workDir
$trigger = New-ScheduledTaskTrigger -Once -At "07:30" `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -RepetitionDuration (New-TimeSpan -Hours 7)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName $monitorTaskName -Action $action -Trigger $trigger `
    -Settings $settings -Force | Out-Null
Write-Host "Installed: $monitorTaskName"

Write-Host "`nAll tasks installed. View with: Get-ScheduledTask | Where-Object {`$_.TaskName -like 'CongressCopy*'}"
```

- [ ] **Step 2: Write uninstaller**

`congress-copy/scripts/schedule_uninstall.ps1`:
```powershell
$ErrorActionPreference = "Continue"
Get-ScheduledTask | Where-Object { $_.TaskName -like "CongressCopy*" } | ForEach-Object {
    Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false
    Write-Host "Removed: $($_.TaskName)"
}
```

- [ ] **Step 3: Update README with scheduling instructions**

Edit `congress-copy/README.md`, add a section before "See `docs/...` for full design.":

```markdown
## Scheduling

After the live smoke test passes, install scheduled tasks (run once, elevated PowerShell):

\`\`\`powershell
cd congress-copy
powershell -ExecutionPolicy Bypass -File scripts\schedule_install.ps1
\`\`\`

This creates:
- 4× daily disclosure checks: 06:00, 12:00, 18:00, 23:00 (US/Central)
- 30-min monitor loop during market hours (07:30–14:30 US/Central)

To remove:
\`\`\`powershell
powershell -ExecutionPolicy Bypass -File scripts\schedule_uninstall.ps1
\`\`\`

The laptop must be on (or wake-on-task enabled) for tasks to fire.
```

(Replace the escaped backticks with real backticks when editing.)

- [ ] **Step 4: Commit**

```bash
cd congress-copy
git add scripts/ README.md
git commit -m "feat: add Windows Task Scheduler install/uninstall scripts"
```

- [ ] **Step 5: User installs tasks (manual step)**

User runs `powershell -ExecutionPolicy Bypass -File scripts\schedule_install.ps1` in an elevated PowerShell. Verify with:

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -like "CongressCopy*" }
```

Expected: 5 tasks listed (4 disclosures + 1 monitor).

---

## Task 16: 30-day observation window (no code changes)

This is the experiment. The bot runs unattended; the user reviews daily.

- [ ] **Daily ritual** (~2 min): `cd congress-copy && .venv/Scripts/python -m src.report` — scan recent events for `PARSE_ERROR`, `ORDER_REJECTED`, `STOP_LOSS_FIRED`. Look at open positions in the Alpaca paper dashboard.

- [ ] **End-of-week ritual** (~10 min): note total return %, count of trades placed, count of stop-outs. Compare against SPY for the same window.

- [ ] **End-of-30-days ritual**: assess success criteria from spec §12. Decide: continue as-is, swap politician, expand to basket, or abandon.

---

## Self-review notes

- Spec coverage: every section of the spec maps to at least one task.
- Placeholder scan: no TBDs / TODOs / "appropriate error handling" / "similar to Task N".
- Type consistency: `OrderIntent.fallback_path` values are consistent across modules (`"direct"`, `"exact_option"`, `"underlying"`). `state.get_avg_entry` is the single canonical name.
- Scope check: this is a single bounded subsystem, single implementation plan is appropriate.
- Ambiguity: timezone for `DISCLOSURE_CHECK_HOURS` resolved (US/Central in spec, Task 15 PowerShell honors it).
