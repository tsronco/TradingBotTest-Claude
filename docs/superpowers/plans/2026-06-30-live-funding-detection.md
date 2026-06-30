# Live-Account Funding Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect deposits/withdrawals on the live (real-money) Alpaca account from its `/v2/account/activities` CSD/CSW records and surface them to `#live-trades`, the daily summary, and a dashboard funding panel + deposit deep-link.

**Architecture:** One authoritative data source (Alpaca account-activities, CSD=deposit / CSW=withdrawal) feeds four surfaces. The bot polls it each live cycle in a new fail-soft `account_funding.py` step (dedup via a committed `account_state_live.json`; first run seeds silently so historical funding never pings). The daily summary adds a "Funding Today" line. The dashboard adds an `activities` API branch + a `FundingPanel` rendered only on the LIVE card. Read-only + notification — zero trading-behavior change.

**Tech Stack:** Python 3.12 (bot, `requests`, pytest); React 19 + TypeScript + Tailwind v4 + react-query (dashboard, vitest); GitHub Actions YAML; Discord webhooks.

**Spec:** [docs/superpowers/specs/2026-06-30-live-funding-detection-design.md](../specs/2026-06-30-live-funding-detection-design.md)

---

## File Structure

**Phase 1 — bot (Python):**
- Modify `alpaca_data.py` — add `get_account_activities()`.
- Create `account_funding.py` — the detector (classify + check + state + CLI).
- Modify `daily_summary.py` — add `_funding_today()` + "Funding Today" field.
- Modify `.github/workflows/tsla-monitor-live.yml` — add the funding step + commit `account_state_live.json`.
- Create `tests/test_account_funding.py` — detector + helper tests.
- Modify `tests/test_daily_summary_funding.py` — funding rollup tests (new file).

**Phase 2 — dashboard (TypeScript):**
- Modify `dashboard/api/alpaca/[endpoint].ts` — add `activities` branch.
- Create `dashboard/src/components/account/FundingPanel.tsx` — funding list + deposit deep-link.
- Modify `dashboard/src/components/account/AccountCard.tsx` — render `FundingPanel` for LIVE.
- Create `dashboard/tests/api/alpaca-activities.test.ts` — endpoint test.
- Create `dashboard/tests/components/FundingPanel.test.tsx` — component test.

**Ship:**
- Modify `dashboard/src/data/changelog.ts`, `dashboard/src/build-version.ts`.

---

## PHASE 1 — Bot detection

### Task 1: `get_account_activities()` in alpaca_data.py

**Files:**
- Modify: `alpaca_data.py` (add after `get_orders`, ~line 199)
- Test: `tests/test_account_funding.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_account_funding.py` with:

```python
import alpaca_data


def test_get_account_activities_builds_request(monkeypatch):
    captured = {}

    def fake_get(url, mode, params=None):
        captured["url"] = url
        captured["mode"] = mode
        captured["params"] = params
        return [{"id": "x", "activity_type": "CSD"}]

    monkeypatch.setattr(alpaca_data, "_get", fake_get)
    out = alpaca_data.get_account_activities(
        "live", ["CSD", "CSW"], after="2026-01-01T00:00:00Z"
    )
    assert out == [{"id": "x", "activity_type": "CSD"}]
    assert captured["url"] == "https://api.alpaca.markets/v2/account/activities"
    assert captured["mode"] == "live"
    assert captured["params"]["activity_types"] == "CSD,CSW"
    assert captured["params"]["after"] == "2026-01-01T00:00:00Z"
    assert captured["params"]["page_size"] == 100
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_account_funding.py::test_get_account_activities_builds_request -v`
Expected: FAIL — `AttributeError: module 'alpaca_data' has no attribute 'get_account_activities'`

- [ ] **Step 3: Add the implementation**

In `alpaca_data.py`, after `get_orders` (the `# ── Options ──` divider is at ~line 201 — insert just above it):

```python
def get_account_activities(
    mode: str,
    activity_types: list[str] | None = None,
    after: str | None = None,
    until: str | None = None,
    page_size: int = 100,
) -> list[dict]:
    """Account activity log (CSD = cash deposit, CSW = cash withdrawal, etc.).

    Used by funding detection to spot real cash transfers — the only reliable
    signal, since equity/cash both move from ordinary trading. Returns the raw
    list (the endpoint returns a JSON array, not a wrapped object). Single page
    (default 100) — sufficient for recent-transfer detection; deep pagination
    intentionally omitted.
    """
    params: dict = {"page_size": page_size, "direction": "desc"}
    if activity_types:
        params["activity_types"] = ",".join(activity_types)
    if after:
        params["after"] = after
    if until:
        params["until"] = until
    return _get(f"{_trading_base(mode)}/account/activities", mode, params=params)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_account_funding.py::test_get_account_activities_builds_request -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add alpaca_data.py tests/test_account_funding.py
git commit -m "feat(bot): add get_account_activities() for funding detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `account_funding.py` detector module

**Files:**
- Create: `account_funding.py`
- Test: `tests/test_account_funding.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_account_funding.py`:

```python
import json

import account_funding
from notifications import Color


def _activity(id_, atype, amount, date="2026-06-30", status="executed"):
    return {
        "id": id_,
        "activity_type": atype,
        "net_amount": str(amount),
        "date": date,
        "status": status,
    }


def _wire(monkeypatch, tmp_path, activities, account=None):
    """Point account_funding at a tmp state file + stubbed Alpaca calls."""
    monkeypatch.setattr(
        account_funding, "_state_path",
        lambda mode: tmp_path / f"account_state_{mode}.json",
    )
    monkeypatch.setattr(
        account_funding, "get_account_activities",
        lambda mode, types, after=None, until=None: list(activities),
    )
    monkeypatch.setattr(
        account_funding, "get_account",
        lambda mode: account or {"cash": "1500", "equity": "1500", "portfolio_value": "1500"},
    )


def _capture(monkeypatch):
    calls = []
    monkeypatch.setattr(account_funding, "send_embed",
                        lambda *a, **k: calls.append((a, k)))
    return calls


def test_classify_activity():
    assert account_funding.classify_activity(_activity("1", "CSD", 1000)) == ("deposit", 1000.0)
    assert account_funding.classify_activity(_activity("2", "CSW", -250)) == ("withdrawal", 250.0)
    assert account_funding.classify_activity(_activity("3", "DIV", 5)) == (None, 0.0)
    assert account_funding.classify_activity(_activity("4", "CSW", 100, status="canceled")) == (None, 0.0)
    assert account_funding.classify_activity({"activity_type": "CSD", "net_amount": "x"}) == (None, 0.0)


def test_first_run_seeds_silently(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path, [_activity("dep1", "CSD", 1000)])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert calls == []  # nothing announced on the seeding run
    state = json.loads((tmp_path / "account_state_live.json").read_text())
    assert "dep1" in state["seen_activity_ids"]


def test_new_deposit_announced_green(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": ["old"]}))
    _wire(monkeypatch, tmp_path, [_activity("dep1", "CSD", 1000)])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args[0] == "live_trades"          # channel
    assert "Deposit" in args[1]              # title
    assert "1,000.00" in args[1]
    assert kwargs["color"] == Color.GREEN


def test_new_withdrawal_announced_red(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": ["old"]}))
    _wire(monkeypatch, tmp_path, [_activity("wd1", "CSW", -500)])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert "Withdrawal" in args[1]
    assert "500.00" in args[1]
    assert kwargs["color"] == Color.RED


def test_dedup_no_reannounce(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": ["dep1"]}))
    _wire(monkeypatch, tmp_path, [_activity("dep1", "CSD", 1000)])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert calls == []


def test_canceled_not_announced_but_recorded(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": ["old"]}))
    _wire(monkeypatch, tmp_path, [_activity("x", "CSW", 100, status="canceled")])
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")
    assert calls == []
    state = json.loads((tmp_path / "account_state_live.json").read_text())
    assert "x" in state["seen_activity_ids"]


def test_fetch_error_is_failsoft(monkeypatch, tmp_path):
    (tmp_path / "account_state_live.json").write_text(json.dumps({"seen_activity_ids": []}))
    monkeypatch.setattr(account_funding, "_state_path",
                        lambda mode: tmp_path / f"account_state_{mode}.json")

    def boom(*a, **k):
        raise RuntimeError("alpaca down")

    monkeypatch.setattr(account_funding, "get_account_activities", boom)
    calls = _capture(monkeypatch)
    account_funding.check_funding("live")  # must not raise
    # Only an error-channel embed (if any), never a trades embed.
    assert all(c[0][0] == "live_errors" for c in calls)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_account_funding.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'account_funding'`

- [ ] **Step 3: Create the module**

Create `account_funding.py`:

```python
"""Live-account funding (deposit/withdrawal) detection.

Reads Alpaca's /v2/account/activities for CSD (cash deposit) and CSW (cash
withdrawal) records — the authoritative cash-transfer log — and announces any
NEW transfer to the mode's Discord trades channel (green deposit / red
withdrawal). This is the only reliable signal: equity and cash both move from
ordinary trading P&L, so an equity-diff would miss small deposits or fire false
alarms. CSD/CSW records appear only for real transfers.

Scope: live (real money). Mode-parameterized, so wiring a paper mode later is a
one-line workflow change — but only live is wired today.

Fully fail-soft: check_funding swallows every error (logs to the mode's errors
channel) and main() always exits 0, so a funding hiccup can never disrupt a
trading cycle. Runs as a continue-on-error step in tsla-monitor-live.yml.

State: account_state_<mode>.json holds the ids already announced (committed back
to the repo so a fresh Actions checkout remembers them). The FIRST run (no state
file) seeds every current CSD/CSW id and announces NOTHING, so historical/initial
funding never pings retroactively — only transfers appearing AFTER the first run
are announced.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

import config
from alpaca_data import get_account, get_account_activities
from notifications import send_embed, Color

load_dotenv()

ROOT = Path(__file__).resolve().parent

# Lookback window for each cycle's fetch. Older transfers are already seeded or
# announced; this only needs to cover the gap since the last run.
LOOKBACK_DAYS = 90
# Bound the stored seen-id list. At a handful of transfers a year this never
# drops an id still inside the LOOKBACK_DAYS fetch window.
MAX_SEEN_IDS = 1000

# Statuses that are NOT a real, completed transfer — skip them.
_DEAD_STATUSES = {"canceled", "cancelled", "rejected", "failed"}


def _state_path(mode: str) -> Path:
    return ROOT / f"account_state_{mode}.json"


def _load_seen(path: Path) -> list[str]:
    try:
        with open(path) as f:
            data = json.load(f)
        return [str(i) for i in data.get("seen_activity_ids", []) if i]
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def _save_seen(path: Path, seen_ids: list[str]) -> None:
    payload = {
        "seen_activity_ids": seen_ids[-MAX_SEEN_IDS:],
        "last_checked": datetime.now(timezone.utc).isoformat(),
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


def classify_activity(act: dict) -> tuple[str | None, float]:
    """Map a raw activity dict to (kind, amount).

    kind is "deposit" (CSD), "withdrawal" (CSW), or None (any other type, or a
    canceled/rejected transfer). amount is always a positive dollar figure;
    direction lives in `kind`, not the sign of net_amount.
    """
    if str(act.get("status", "")).lower() in _DEAD_STATUSES:
        return None, 0.0
    try:
        amount = abs(float(act.get("net_amount", 0) or 0))
    except (TypeError, ValueError):
        return None, 0.0
    atype = act.get("activity_type")
    if atype == "CSD":
        return "deposit", amount
    if atype == "CSW":
        return "withdrawal", amount
    return None, 0.0


def _announce(kind, amount, act, account, trades_ch, actions_ch, mode):
    is_deposit = kind == "deposit"
    emoji = "💰" if is_deposit else "💸"
    sign = "+" if is_deposit else "−"
    color = Color.GREEN if is_deposit else Color.RED
    word = "Deposit" if is_deposit else "Withdrawal"

    fields = [{"name": "Amount", "value": f"{sign}${amount:,.2f}", "inline": True}]
    cash = account.get("cash")
    equity = account.get("equity", account.get("portfolio_value"))
    if cash is not None:
        try:
            fields.append({"name": "New cash", "value": f"${float(cash):,.2f}", "inline": True})
        except (TypeError, ValueError):
            pass
    if equity is not None:
        try:
            fields.append({"name": "New equity", "value": f"${float(equity):,.2f}", "inline": True})
        except (TypeError, ValueError):
            pass
    if act.get("date"):
        fields.append({"name": "Date", "value": str(act["date"]), "inline": True})

    send_embed(
        trades_ch,
        f"{emoji} {word} detected: {sign}${amount:,.2f}",
        color=color,
        fields=fields,
        footer=f"account_funding.py · {mode}",
        actions_channel=actions_ch,
    )


def check_funding(mode: str) -> None:
    """Detect and announce new deposits/withdrawals for `mode`. Fail-soft."""
    cfg = config.get_mode(mode)
    trades_ch = cfg["trades_channel"]
    actions_ch = cfg["actions_channel"]
    errors_ch = cfg["errors_channel"]
    path = _state_path(mode)

    try:
        after = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).isoformat()
        activities = get_account_activities(mode, ["CSD", "CSW"], after=after) or []

        first_run = not path.exists()
        seen = _load_seen(path)
        seen_set = set(seen)
        new_acts = [a for a in activities if a.get("id") and a["id"] not in seen_set]

        if first_run:
            for a in activities:
                if a.get("id") and a["id"] not in seen_set:
                    seen.append(a["id"])
                    seen_set.add(a["id"])
            _save_seen(path, seen)
            return

        if new_acts:
            try:
                account = get_account(mode)
            except Exception:
                account = {}  # balance context is optional; never block the ping
            for a in sorted(new_acts, key=lambda x: str(x.get("date", ""))):
                kind, amount = classify_activity(a)
                if kind is not None:
                    _announce(kind, amount, a, account, trades_ch, actions_ch, mode)
                seen.append(a["id"])
                seen_set.add(a["id"])

        _save_seen(path, seen)

    except Exception as e:
        send_embed(
            errors_ch,
            f"account_funding.py error ({mode})",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:400]}`",
            footer=f"account_funding.py · {mode}",
            actions_channel=actions_ch,
        )


def main() -> None:
    mode, _ = config.parse_mode_arg(sys.argv[1:])
    check_funding(mode)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_account_funding.py -v`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add account_funding.py tests/test_account_funding.py
git commit -m "feat(bot): account_funding.py — live deposit/withdrawal detection

Polls /v2/account/activities CSD/CSW, dedups via account_state_live.json,
announces new transfers (green/red) to #live-trades. First run seeds
silently. Fully fail-soft.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Daily-summary "Funding Today" line

**Files:**
- Modify: `daily_summary.py` (add `_funding_today` near `_get_positions` ~line 98; add field in `run_daily_summary` after the `fields = [...]` init ~line 469)
- Test: `tests/test_daily_summary_funding.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_daily_summary_funding.py`:

```python
import config
import daily_summary


class _FakeResp:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


def test_funding_today_sums_executed(monkeypatch):
    acts = [
        {"activity_type": "CSD", "net_amount": "1000", "date": "2026-06-30"},
        {"activity_type": "CSW", "net_amount": "-250", "date": "2026-06-30"},
        {"activity_type": "CSD", "net_amount": "500", "date": "2026-06-29"},  # not today
    ]
    monkeypatch.setattr(daily_summary.requests, "get", lambda *a, **k: _FakeResp(acts))
    dep, wd = daily_summary._funding_today(config.get_mode("live"), "2026-06-30")
    assert dep == 1000.0
    assert wd == 250.0


def test_funding_today_failsoft(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("network")

    monkeypatch.setattr(daily_summary.requests, "get", boom)
    dep, wd = daily_summary._funding_today(config.get_mode("live"), "2026-06-30")
    assert (dep, wd) == (0.0, 0.0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_daily_summary_funding.py -v`
Expected: FAIL — `AttributeError: module 'daily_summary' has no attribute '_funding_today'`

- [ ] **Step 3: Add `_funding_today` helper**

In `daily_summary.py`, after `_get_positions` (~line 98), add:

```python
def _funding_today(cfg: dict, today: str) -> tuple[float, float]:
    """Sum today's real-money cash deposits/withdrawals (live only).

    Returns (deposits, withdrawals) as positive dollar amounts. Fail-soft —
    returns (0.0, 0.0) on any error so a funding-fetch hiccup never breaks the
    summary embed. `today` is the "%Y-%m-%d" date string already computed by
    run_daily_summary.
    """
    try:
        resp = requests.get(
            f"{_base_url_for(cfg)}/account/activities",
            headers=_headers_for(cfg),
            params={"activity_types": "CSD,CSW", "page_size": 100, "direction": "desc"},
            timeout=10,
        )
        resp.raise_for_status()
        deposits = withdrawals = 0.0
        for a in resp.json():
            if a.get("date") != today:
                continue
            try:
                amt = abs(float(a.get("net_amount", 0) or 0))
            except (TypeError, ValueError):
                continue
            if a.get("activity_type") == "CSD":
                deposits += amt
            elif a.get("activity_type") == "CSW":
                withdrawals += amt
        return deposits, withdrawals
    except Exception:
        return 0.0, 0.0
```

- [ ] **Step 4: Add the field to the embed**

In `run_daily_summary`, immediately after the `fields = [ {Equity}, {Cash} ]` initialization (the block ending `]` at ~line 469), insert:

```python
        # Funding Today (live only — real-money deposits/withdrawals). Paper
        # accounts don't move real cash, so this is gated to live mode.
        if mode_name == "live":
            _deposits, _withdrawals = _funding_today(cfg, today)
            if _deposits or _withdrawals:
                _parts = []
                if _deposits:
                    _parts.append(f"Deposits +${_deposits:,.2f}")
                if _withdrawals:
                    _parts.append(f"Withdrawals −${_withdrawals:,.2f}")
                fields.append({
                    "name": "💵 Funding Today",
                    "value": " · ".join(_parts),
                    "inline": False,
                })
```

- [ ] **Step 5: Run tests + full suite to verify**

Run: `python -m pytest tests/test_daily_summary_funding.py -v`
Expected: PASS

Run: `python -m pytest tests/ -q`
Expected: PASS (all existing + new tests green)

- [ ] **Step 6: Commit**

```bash
git add daily_summary.py tests/test_daily_summary_funding.py
git commit -m "feat(bot): daily-summary 'Funding Today' line (live)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire the funding step into the live workflow

**Files:**
- Modify: `.github/workflows/tsla-monitor-live.yml`

- [ ] **Step 1: Verify state file is not gitignored**

Run: `git check-ignore account_state_live.json; echo "exit=$?"`
Expected: `exit=1` (i.e. NOT ignored — like `strategy_state_live.json`). If it prints the filename (exit 0), add a `!account_state_*.json` un-ignore to `.gitignore` before continuing.

- [ ] **Step 2: Add the funding step**

In `.github/workflows/tsla-monitor-live.yml`, after the "Run long-options manager (live)" step (ends at line 74) and BEFORE "Push wheel state (live) to dashboard", insert:

```yaml
      - name: Detect funding (live — deposit/withdrawal notices)
        continue-on-error: true
        env:
          ALPACA_LIVE_API_KEY:           ${{ secrets.ALPACA_LIVE_API_KEY }}
          ALPACA_LIVE_API_SECRET:        ${{ secrets.ALPACA_LIVE_API_SECRET }}
          ALPACA_LIVE_BASE_URL:          ${{ secrets.ALPACA_LIVE_BASE_URL }}
          DISCORD_LIVE_TRADES_WEBHOOK:   ${{ secrets.DISCORD_LIVE_TRADES_WEBHOOK }}
          DISCORD_LIVE_ERRORS_WEBHOOK:   ${{ secrets.DISCORD_LIVE_ERRORS_WEBHOOK }}
          DISCORD_LIVE_ACTIONS_WEBHOOK:  ${{ secrets.DISCORD_LIVE_ACTIONS_WEBHOOK }}
        run: python account_funding.py --mode live
```

- [ ] **Step 3: Commit the new state file in the commit step**

In the "Commit state and logs" step, after the line `git add wheel_state_live.json 2>/dev/null || true` (line 128), add:

```yaml
          git add account_state_live.json 2>/dev/null || true
```

- [ ] **Step 4: Validate the YAML parses**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/tsla-monitor-live.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/tsla-monitor-live.yml
git commit -m "ci(live): run account_funding step + commit account_state_live.json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE 2 — Dashboard surfaces

### Task 5: `activities` API branch

**Files:**
- Modify: `dashboard/api/alpaca/[endpoint].ts` (add branch alongside `account`/`positions`, ~line 61)
- Test: `dashboard/tests/api/alpaca-activities.test.ts`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/api/alpaca-activities.test.ts`. Mirror the vi.mock pattern used in the sibling tests under `dashboard/tests/api/` (mock `../../api/_lib/auth-guard.js` so `requireAuth` returns true, and `../../api/_lib/data-api.js` so `alpacaTrade` is a vi.fn):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/auth-guard.js', () => ({ requireAuth: () => true }));
const alpacaTrade = vi.fn();
vi.mock('../../api/_lib/data-api.js', () => ({
  alpacaTrade: (...a: unknown[]) => alpacaTrade(...a),
  alpacaData: vi.fn(),
  alpacaTradeMutation: vi.fn(),
}));

import handler from '../../api/alpaca/[endpoint]';

function mockRes() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  return res;
}

describe('GET /api/alpaca/activities', () => {
  beforeEach(() => alpacaTrade.mockReset());

  it('returns CSD/CSW activities for the live account', async () => {
    alpacaTrade.mockResolvedValue([
      { id: '1', activity_type: 'CSD', net_amount: '1000', date: '2026-06-30' },
    ]);
    const req = { method: 'GET', query: { endpoint: 'activities', mode: 'live' } };
    const res = mockRes();
    await handler(req as never, res as never);
    expect(alpacaTrade).toHaveBeenCalledWith(
      'live',
      '/v2/account/activities',
      { activity_types: 'CSD,CSW', page_size: 50 },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      mode: 'live',
      activities: [{ id: '1', activity_type: 'CSD', net_amount: '1000', date: '2026-06-30' }],
    });
  });
});
```

> If a sibling test in `dashboard/tests/api/` uses a shared `mockRes`/handler-invocation helper, prefer that helper over the inline `mockRes` above to stay consistent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/alpaca-activities.test.ts`
Expected: FAIL — handler returns a 400/`unknown endpoint` (no `activities` branch yet).

- [ ] **Step 3: Add the branch**

In `dashboard/api/alpaca/[endpoint].ts`, after the `positions` branch (ends ~line 65), add:

```ts
    if (endpoint === 'activities') {
      const activities = await alpacaTrade<unknown>(mode, '/v2/account/activities', {
        activity_types: 'CSD,CSW',
        page_size: 50,
      });
      return res.status(200).json({ mode, activities });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/alpaca-activities.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/alpaca/[endpoint].ts dashboard/tests/api/alpaca-activities.test.ts
git commit -m "feat(dashboard): /api/alpaca/activities (CSD/CSW)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `FundingPanel` + LIVE-card wiring

**Files:**
- Create: `dashboard/src/components/account/FundingPanel.tsx`
- Modify: `dashboard/src/components/account/AccountCard.tsx` (import + render for LIVE)
- Test: `dashboard/tests/components/FundingPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/components/FundingPanel.test.tsx`. Use the project's existing component-test render helper if present (e.g. a `renderWithClient`/`renderWithProviders` util under `dashboard/tests/`); otherwise wrap in a `QueryClientProvider` as below:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../src/lib/api', () => ({
  api: vi.fn(async () => ({
    activities: [
      { id: '1', activity_type: 'CSD', net_amount: '1000', date: '2026-06-30' },
      { id: '2', activity_type: 'CSW', net_amount: '-250', date: '2026-06-29' },
    ],
  })),
}));

import FundingPanel from '../../src/components/account/FundingPanel';

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FundingPanel mode="live" />
    </QueryClientProvider>,
  );
}

describe('FundingPanel', () => {
  it('shows deposits/withdrawals and a deposit deep-link', async () => {
    renderPanel();
    expect(await screen.findByText(/deposit/i)).toBeInTheDocument();
    expect(await screen.findByText(/withdrawal/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /deposit funds/i });
    expect(link).toHaveAttribute('href', 'https://app.alpaca.markets/brokerage/funding/deposit/ach');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/components/FundingPanel.test.tsx`
Expected: FAIL — cannot resolve `../../src/components/account/FundingPanel`.

- [ ] **Step 3: Create the component**

Create `dashboard/src/components/account/FundingPanel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';

const DEPOSIT_URL = 'https://app.alpaca.markets/brokerage/funding/deposit/ach';

interface Activity {
  id: string;
  activity_type: string; // 'CSD' (deposit) | 'CSW' (withdrawal)
  date?: string;
  net_amount?: string;
}

export default function FundingPanel({ mode }: { mode: 'manual' | 'live' }) {
  const { data } = useQuery({
    queryKey: ['activities', mode],
    queryFn: () => api<{ activities: Activity[] }>(`/api/alpaca/activities?mode=${mode}`),
    staleTime: 60_000,
  });

  const transfers = (data?.activities ?? []).filter(
    (a) => a.activity_type === 'CSD' || a.activity_type === 'CSW',
  );

  return (
    <div className="px-5 pb-3">
      <div className="text-[10px] tracking-[0.25em] text-dim mb-2">FUNDING</div>
      {transfers.length === 0 ? (
        <div className="text-[11px] text-dim">no deposits or withdrawals yet</div>
      ) : (
        <ul className="space-y-1">
          {transfers.slice(0, 5).map((a) => {
            const isDep = a.activity_type === 'CSD';
            const amt = Math.abs(Number(a.net_amount ?? 0));
            const dollars = fmtUsd(amt, { sign: false }).replace('-$', '$');
            return (
              <li key={a.id} className="flex items-center justify-between text-[11px] tnum">
                <span className="text-dim">{a.date ?? '—'}</span>
                <span className={isDep ? 'text-hi' : 'text-red'}>
                  {isDep ? '▲ deposit ' : '▼ withdrawal '}
                  {isDep ? '+' : '−'}{dollars}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <a
        href={DEPOSIT_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-[11px] text-cyan hover:underline"
      >
        Deposit funds ↗
      </a>
    </div>
  );
}
```

- [ ] **Step 4: Wire into AccountCard (LIVE only)**

In `dashboard/src/components/account/AccountCard.tsx`:

Add the import after the other component imports (~line 5):

```tsx
import FundingPanel from './FundingPanel';
```

Render it just before the `{/* footer status */}` comment / `<footer ...>` block (~line 297):

```tsx
      {acctKey === 'LIVE' && <FundingPanel mode={mode} />}
```

- [ ] **Step 5: Run test + dashboard suite to verify**

Run: `cd dashboard && npx vitest run tests/components/FundingPanel.test.tsx`
Expected: PASS

Run: `cd dashboard && npx vitest run --pool=threads`
Expected: PASS (full dashboard suite green)

Run: `cd dashboard && npx tsc -b`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/account/FundingPanel.tsx dashboard/src/components/account/AccountCard.tsx dashboard/tests/components/FundingPanel.test.tsx
git commit -m "feat(dashboard): live funding panel + deposit deep-link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Ship — changelog, version bump, full suites, deploy, push

**Files:**
- Modify: `dashboard/src/data/changelog.ts`, `dashboard/src/build-version.ts`

- [ ] **Step 1: Add changelog entry**

Prepend to the `CHANGELOG` array in `dashboard/src/data/changelog.ts` (newest first, above the most recent entry):

```ts
  {
    date: '2026-06-30',
    category: 'feature',
    title: 'Live-account funding detection — deposit/withdrawal notices',
    details:
      'The bot now notices when real money moves on the live account. It reads '
      + "Alpaca's account-activity log (CSD deposits / CSW withdrawals — the "
      + 'authoritative transfer record, not a guess from equity swings) each '
      + 'live cycle and posts a 🟢 deposit / 🔴 withdrawal embed to #live-trades '
      + 'with the exact amount and resulting balance. The 4:12 PM live summary '
      + 'gains a "Funding Today" line, and the live account card gains a funding '
      + 'panel plus a "Deposit funds ↗" shortcut straight to Alpaca\'s ACH deposit '
      + 'page. First run seeds silently so historical funding never pings. '
      + 'Read-only + notification — no trading behavior changed. (You still '
      + "deposit on Alpaca's site — the Trading API can't move money — but the "
      + 'system is now aware of it.)',
  },
```

- [ ] **Step 2: Bump version (bot + dashboard both changed)**

Edit `dashboard/src/build-version.ts` — change the `BUILD_VERSION` line from `'0.6.38'` to:

```ts
export const BUILD_VERSION = '0.7.39';
```

> Manual bump (bot digit 6→7, dashboard digit 38→39) because the per-task commits already landed; `npm run bump` reads the *staged* diff and would only see these two files. If the current version differs from `0.6.38` at ship time, bump bot +1 and dashboard +1 from whatever it actually is.

- [ ] **Step 3: Run BOTH full suites**

Run: `python -m pytest tests/ -q`
Expected: PASS (existing total + ~10 new funding tests)

Run: `cd dashboard && npx vitest run --pool=threads && npx tsc -b`
Expected: PASS, no tsc errors

- [ ] **Step 4: Commit + push (rebase if a bot state push raced)**

```bash
git add dashboard/src/data/changelog.ts dashboard/src/build-version.ts
git commit -m "chore: changelog + bump 0.7.39 for live funding detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main || (git pull --rebase origin main && git push origin main)
```

- [ ] **Step 5: Deploy the dashboard**

Run: `cd dashboard && npx vercel --prod --yes`
Expected: `readyState: READY`, aliased to `https://tradingbot-dashboard-blue.vercel.app`. Confirm the build log is clean.

---

## Self-Review

**Spec coverage:**
- Discord ping → Task 2 (`_announce` + `check_funding`). ✅
- Daily-summary line → Task 3. ✅
- Dashboard panel → Task 6. ✅
- Deposit deep-link → Task 6 (`DEPOSIT_URL`). ✅
- Activities-based detection (not equity-diff) → Tasks 1–2. ✅
- First-run silent seeding → Task 2 (`first_run` branch) + test. ✅
- Fail-soft → Task 2 (try/except + `continue-on-error` in Task 4) + test. ✅
- State committed back → Task 4 Step 3. ✅
- Live only → daily-summary gated on `mode_name == "live"` (Task 3); workflow wired only on live (Task 4). ✅
- Tests (bot pytest + dashboard vitest) → every task is TDD. ✅

**Placeholder scan:** No TBD/TODO. The one "follow the existing test helper" note in Tasks 5–6 references concrete sibling patterns with exact assertions given inline — acceptable, not a placeholder.

**Type consistency:** `get_account_activities(mode, activity_types, after, until, page_size)` defined in Task 1, called the same way in Task 2 (`get_account_activities(mode, ["CSD","CSW"], after=...)`) and the dashboard mirror in Task 5. `classify_activity → (kind, amount)` consistent across Task 2 code + tests. `check_funding(mode)` and `_state_path(mode)` names consistent. `FundingPanel({ mode })` prop matches AccountCard usage. Channel names (`live_trades`, `live_errors`, `live_actions`) match `config.MODES["live"]`. `BUILD_VERSION` 0.6.38→0.7.39 consistent.

## Execution

Per Tim's standing preference (subagent-driven execution for every plan) and his "do it autonomously" instruction for this work: execute with **superpowers:subagent-driven-development** — fresh subagent per task, review between tasks — without pausing for an execution-mode choice.
