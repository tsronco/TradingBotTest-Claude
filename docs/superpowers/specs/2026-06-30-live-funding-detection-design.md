# Live-account funding (deposit/withdrawal) detection — design

- **Date:** 2026-06-30
- **Status:** Approved (brainstorm) → spec
- **Scope:** Live (real-money) account only
- **Author:** Tim + Claude

## Motivation

Tim asked whether he can deposit money into the live Alpaca account *from the
dashboard*. He can't: deposits/withdrawals (bank linking, ACH) live only in
Alpaca's **Broker API** (`broker-api.alpaca.markets/v1/.../transfers`), a
product for fintech businesses onboarding their own end-users. Our bot and
dashboard use the **Trading API** (`/v2`), which has **no money-movement
endpoints** for a retail self-directed account. Funding stays on Alpaca's
website/app by design.

What we *can* do is make the system **aware** of money that moves. The bot
already reads live cash/equity every cycle, so deposited funds are *used*
automatically on the next wheel/strategy cycle — it just never *announces* the
event. This feature adds that awareness and surfaces it in four places, plus a
convenience deep-link to Alpaca's own deposit page.

## Goals

1. Detect deposits and withdrawals on the live account reliably (no false
   positives from normal trading P&L).
2. Ping `#live-trades` the cycle after money moves — green deposit, red
   withdrawal, with the **exact** transfer amount and resulting balance.
3. Roll a "Funding Today" line into the 4:12 PM live daily-summary embed.
4. Show a funding-history panel on the live account card in the dashboard.
5. Provide a "Deposit funds ↗" deep-link to Alpaca's banking page.

## Non-goals

- Initiating deposits/withdrawals from our code (impossible on the Trading API).
- Any change to trading behavior. This feature is read-only + notification.
- Paper-account funding detection (manual/etc.) — live only. The code is
  mode-parameterized, so a future paper add is a one-line toggle, but it is out
  of scope here (paper "deposits" are low-signal balance resets).

## Approach decision: account-activities, not equity-diff

The CLAUDE.md backlog note sketched an **equity-diff** approach (stash last-seen
equity each cycle, fire when it jumps past a threshold). We reject it:

| | Equity/cash diff | **account_activities (CSD/CSW)** ✅ |
|---|---|---|
| Mechanism | Compare this cycle's equity/cash vs last | Read explicit cash-transfer records |
| Distinguishes deposit from a trade? | ❌ No — premium, fills, assignment, price ticks all move equity/cash | ✅ Yes — CSD/CSW are *only* transfers |
| Exact transfer amount | ❌ Inferred, noisy | ✅ Exact, from the record |
| Feeds all 4 surfaces from one source | ❌ | ✅ |
| New endpoint | none | `/v2/account/activities` (Trading API; dashboard already uses it for close-detection) |

On an account holding positions, equity moves every tick and cash moves on every
fill, so an equity-diff would either cry wolf or miss small deposits. Alpaca's
**`/v2/account/activities`** with `activity_types=CSD,CSW` returns authoritative
cash-transfer records (CSD = cash deposit, CSW = cash withdrawal), each with a
stable `id`, `date`, `net_amount`, and `status`. That is the single source of
truth for every surface.

## Architecture

```
Alpaca  GET /v2/account/activities?activity_types=CSD,CSW
        │
   ┌────┴───────────────┬────────────────────┬────────────────────┐
   ▼                    ▼                    ▼                    ▼
Discord ping       Daily-summary        Dashboard panel      Deep-link button
#live-trades       "Funding Today"      (funding history)    "Deposit funds ↗"
per-cycle          4:12 PM rollup       web card             static link
(Phase 1)          (Phase 1)            (Phase 2)            (Phase 2)
```

### Bot side (Python) — Phase 1

**1. `alpaca_data.get_account_activities(mode, activity_types, after=None, until=None)`**
- New helper alongside `get_account` ([alpaca_data.py:151](../../../alpaca_data.py)).
- Wraps `_get(f"{_trading_base(mode)}/account/activities", mode, params=...)`,
  reusing the existing bounded-retry client.
- `params`: `{"activity_types": ",".join(types), "after": after, "until": until,
  "page_size": 100, "direction": "desc"}` (None values omitted).
- Returns the raw list of activity dicts. Pagination beyond 100 is unnecessary
  here (a cycle only needs recent transfers); documented as a known bound.

**2. `account_funding.py` (new module)** — the detector.
- `check_funding(mode) -> None`:
  1. Fetch CSD + CSW activities (recent window — `after = now − 90 days`, matching
     the prune window in step 5 so the fetch and the seen-set cover the same span).
  2. Load `account_state_<mode>.json` → `seen_activity_ids` (set).
  3. **First-run seed:** if the state file does not exist, record *all* current
     CSD/CSW ids and announce **nothing** (so historical/initial funding never
     pings retroactively). Write state, return.
  4. For each activity whose `id` is new and `status` is terminal (not
     `canceled`/`rejected`): post an embed (below), add the id to `seen`.
  5. Prune `seen` to ids seen within the last ~90 days to bound file growth.
  6. Persist `seen_activity_ids` + `last_checked` to state.
- Embed (via `notifications.discord.send_embed`, channel `live_trades`,
  `actions_channel="live_actions"`):
  - **CSD (deposit):** `Color.GREEN`, title `💰 Deposit detected: +$1,000.00`,
    fields for new cash + new equity (read from `get_account(mode)` once).
  - **CSW (withdrawal):** `Color.RED`, title `💸 Withdrawal detected: −$500.00`.
  - Color/emoji/sign keyed off `activity_type` (not `net_amount` sign).
- `main()`: parse `--mode` (reuse the standard mode-arg parser), call
  `check_funding`, wrapped in try/except that logs to `#live-errors` and exits 0
  — **fully fail-soft**, never raises.

**3. `account_state_live.json` (new state file)**
- Shape: `{"seen_activity_ids": ["...", ...], "last_checked": "ISO-8601"}`.
- Committed back to the repo by the workflow (like the other live state files)
  so seen-ids persist across fresh-checkout Action runs.

**4. `tsla-monitor-live.yml`**
- New step after long-options ([tsla-monitor-live.yml:66](../../../.github/workflows/tsla-monitor-live.yml)):
  `python account_funding.py --mode live`, with `continue-on-error: true` and
  the LIVE env block (`ALPACA_LIVE_*`, `DISCORD_LIVE_TRADES_WEBHOOK`,
  `DISCORD_LIVE_ERRORS_WEBHOOK`, `DISCORD_LIVE_ACTIONS_WEBHOOK`).
- Add `git add account_state_live.json 2>/dev/null || true` to the commit step.

**5. `daily_summary.py` (live step)**
- Add a `💵 Funding Today` field to the live summary embed: sum executed CSD
  (deposits, `+`) and CSW (withdrawals, `−`) whose `date` is today (ET).
- Reuse `get_account_activities`. Field is **omitted entirely** when there is no
  funding activity today (clean embed on normal days).

### Dashboard side (TypeScript) — Phase 2

**6. `/api/alpaca/[endpoint].ts` — `activities` branch**
- New `endpoint === 'activities'` branch calling
  `alpacaTrade(mode, '/v2/account/activities?activity_types=CSD,CSW&page_size=50')`.
- Auth-guarded like the others; honors the live guard.

**7. Live account card — Funding panel + deep-link**
- A "Funding" panel listing recent deposits/withdrawals (date, type, amount,
  signed/colored) for the live account, fed by the new endpoint.
- A "Deposit funds ↗" button linking to
  `https://app.alpaca.markets/brokerage/funding/deposit/ach` (Tim-confirmed — the
  ACH deposit page that lands directly on the amount entry) opened in a new tab
  with `target="_blank" rel="noopener noreferrer"`.

## Data flow

1. cron-job.org dispatches the live monitor every 10 min (market hours).
2. After the trading scripts, `account_funding.py --mode live` runs.
3. It pulls CSD/CSW, diffs against committed `account_state_live.json`, and
   announces any new transfer to `#live-trades` (+ `#live-actions` mirror).
4. State is committed back so the next run won't re-announce.
5. At 4:12 PM, `daily_summary.py --mode live` adds the "Funding Today" line.
6. The dashboard reads CSD/CSW live from Alpaca on demand for the panel.

## Error handling

- `account_funding.check_funding` is wrapped in try/except; any failure logs to
  `#live-errors` and the process exits 0. The workflow step is
  `continue-on-error: true`. **A funding-check failure can never disrupt a
  trading cycle or block the dashboard push / state-commit steps.**
- `notifications.discord` already swallows webhook errors (fail-soft).
- If the activities fetch returns partial/garbage data, unknown ids simply
  aren't announced; a malformed record is skipped, not fatal.

## Testing

**Bot (pytest)** — Alpaca + Discord mocked, per `conftest.py`:
- New executed CSD → one green embed with the right amount.
- New CSW → one red embed.
- Same activity id on a later cycle → **no** re-announcement (dedup).
- First run (no state file) → seeds ids, announces nothing.
- `canceled`/`rejected` activity → not announced.
- Activities fetch raises → `check_funding` swallows it, no crash, no embed.
- Daily-summary rollup: mixed CSD/CSW today → correct signed sum; none today →
  field omitted.

**Dashboard (vitest):**
- `activities` endpoint returns the CSD/CSW shape and respects the live guard.
- Funding panel renders deposits/withdrawals with correct sign/color; empty
  state renders nothing intrusive.
- Deep-link button has the correct href + `target="_blank"` `rel="noopener"`.

## Phasing

- **Phase 1 (real-money value first):** bot detection — `get_account_activities`,
  `account_funding.py`, state file, workflow step, daily-summary line. Ships and
  validates on the live account independently.
- **Phase 2:** dashboard `activities` endpoint, funding panel, deposit deep-link.

## Open items

- None. Deposit deep-link URL confirmed by Tim:
  `https://app.alpaca.markets/brokerage/funding/deposit/ach`.
```
