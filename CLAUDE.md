# TradingBotTest-Claude

Alpaca paper trading sandbox running three bots on **GitHub Actions cron** (migrated from local Claude routines on 2026-04-28). Notifications flow to a private Discord server; structured logs are committed back to this repo as JSONL.

## Architecture at a glance

```
┌─ GitHub Actions cron ────────────────────────────────────────────┐
│  tsla-monitor.yml      (every 30 min, 9 AM–4 PM ET, Mon–Fri)     │
│    ├─ strategy.py once       (TSLA stock: trail stop + ladder)   │
│    └─ wheel_strategy.py once (TSLA wheel: puts → calls → repeat) │
│                                                                   │
│  congress-copy.yml     (9 / 11 / 1 / 3 PM ET, Mon–Fri)           │
│    ├─ disclosures cycle  (scrape 4 politicians + copy trades)    │
│    └─ monitor cycle      (-15% stop loss on copied positions)    │
│                                                                   │
│  daily-summary.yml     (4:05 PM ET, Mon–Fri)                     │
│    └─ daily_summary.py   (combined P&L report)                   │
└──────────────────────────────────────────────────────────────────┘
        │                                 │
        ▼                                 ▼
   Alpaca paper API              Discord webhooks (5 channels)
   (one shared $100K account)    + JSONL logs committed back
```

## Environment

Credentials live in `.env` (gitignored). The same values are mirrored as **GitHub Actions secrets** for hosted runs.

```
ALPACA_API_KEY=...
ALPACA_API_SECRET=...
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2

DISCORD_TSLA_WEBHOOK=https://discord.com/api/webhooks/...
DISCORD_CONGRESS_WEBHOOK=...
DISCORD_SUMMARY_WEBHOOK=...
DISCORD_ERRORS_WEBHOOK=...
DISCORD_ACTIONS_WEBHOOK=...
```

**Paper trading only.** Base URL must stay as `paper-api.alpaca.markets`. The `paper_guard.py` module asserts this on every congress-copy invocation.

## Scheduled workflows

All cron expressions are in **UTC**. Times below are translated for clarity.

| Workflow | Cron (UTC) | CT | ET | Covers |
|---|---|---|---|---|
| `tsla-monitor.yml` | `7,37 13-20 * * 1-5` | 8:07/:37 AM–3:37 PM | 9:07/:37 AM–4:37 PM | Strategy + wheel |
| `congress-copy.yml` | `7 13,15,17,19 * * 1-5` | 8:07/10:07/12:07/2:07 PM | 9:07/11:07/1:07/3:07 PM | Scrape + monitor |
| `daily-summary.yml` | `12 20 * * 1-5` | 3:12 PM | 4:12 PM | Combined P&L report |

**Note**: cron times are intentionally OFF the :00/:30 marks. GitHub Actions scheduled workflows get throttled at peak load times (every :00 and :30 of the hour), so we use :07/:37/:12 to stay reliable.

NYSE regular hours: 9:30 AM–4:00 PM ET = 13:30–20:00 UTC. Cron fires that fall outside market hours are handled correctly:
- **Wheel** has an `is_market_open()` guard that skips the cycle when market is closed (logs a JSONL heartbeat, doesn't touch state).
- **Strategy** runs anyway — it's just monitoring price, no order placement on heartbeat cycles.
- **Congress monitor** has a built-in market-closed early return.

⚠️ **DST changes**: cron values above are correct for **CDT** (March–November). When DST ends in early November, shift each UTC hour value +1.

## Discord channels

| Channel | What lands there | Phone notification setting |
|---|---|---|
| `#tsla-trades` | Strategy fills/stops/ladders, wheel sells/closes/assignments | Mentions only |
| `#congress-trades` | Copy trades placed, congress stop-outs | Mentions only |
| `#daily-summary` | 4:05 PM ET combined P&L summary | All messages (push) |
| `#errors` | API failures, rejected orders, scraper crashes, exceptions | All messages (push, with @mention) |
| `#all-actions` | Mirror of everything for one-scroll review | Muted |

**If `#errors` stays empty all day, the system worked.**

## Strategies in detail

### TSLA stock — `strategy.py`
- **Entry**: 10 shares (already filled, avg cost in `strategy_state.json`)
- **Stop loss**: sell all if price drops 10% below current avg cost (recalculates after each ladder)
- **Trailing**: activates at +10% from entry; floor sits 5% below high-water mark, never moves down
- **Ladder 1**: −15% from entry → buy 8 more shares
- **Ladder 2**: −25% from entry → buy 12 more shares
- **Ladder 3**: −40% from entry → buy 20 more shares
- After each ladder: stop recalculates to `new_avg_cost × 0.90`

### TSLA wheel — `wheel_strategy.py`
- **Stage 1 — Cash-secured puts**:
  - Strike: ~10% below current TSLA price, rounded to nearest $5
  - Expiration: 2–4 weeks out (target ~3 weeks)
  - Cash check: only sell if `strike × 100 ≤ cash`
  - 50% profit rule: buy-to-close if option drops to half its entry premium
  - If assigned → 100 shares acquired → move to Stage 2
- **Stage 2 — Covered calls**:
  - Strike: ~10% above cost basis, rounded to nearest $5, **never below cost basis**
  - Expiration: 1–3 weeks out
  - 50% profit rule applies
  - If called away → back to Stage 1

### Congress copy — `congress-copy/`
Tracks 4 politicians (`config.py → POLITICIANS`):
- **G000583 — Josh Gottheimer** (original)
- **P000197 — Nancy Pelosi** (very active historically)
- **T000278 — Tommy Tuberville** (frequent disclosures)
- **G000597 — Daniel Goldman** (newer member, fairly active)

Pulls disclosures from CapitolTrades, sizes positions by tier (`config.SIZING_TIERS`), submits paper orders, and runs an independent `-15%` stop-loss monitor on positions IT opened (won't touch TSLA shares or wheel options — verified via `state.get_avg_entry()` gate).

## Daily summary

`daily_summary.py` aggregates state from all three bots (strategy_state.json + wheel_state.json + congress-copy/data/state.db) and posts one combined embed to `#daily-summary` at 4:05 PM ET.

## Runbook — when something breaks

### `#errors` is pinging — what do I do?

1. Open the most recent message. The embed includes the script name, exception type, and a snippet of the traceback.
2. If the error is in the **scraper** for one politician (e.g., "Pelosi" failed), the slug may be stale. Check `https://www.capitoltrades.com/politicians/<slug>` in a browser. If 404, find the correct slug and update `congress-copy/config.py → POLITICIANS`.
3. If the error is **`order_rejected`**, check the reason text. Common causes: insufficient buying power, market closed, position not tradeable.
4. If a **workflow itself** failed (run shows red ✓ in https://github.com/tsronco/TradingBotTest-Claude/actions), open the run, find the failed step, read the log.

### A workflow didn't fire when expected

1. Check **https://github.com/tsronco/TradingBotTest-Claude/actions** — does the run appear?
2. GitHub Actions cron has a deterministic delay of a few minutes at dispatch time — a 13:00 UTC fire may actually run at 13:01–13:05 UTC.
3. If completely missing for ≥10 min past the scheduled time, GitHub may be having an outage. Workflows can be triggered manually: `gh workflow run <workflow-name>`.

### State file drift / "double-place" symptoms

State files (`strategy_state.json`, `wheel_state.json`, `congress-copy/data/state.db`) are committed back to the repo by each workflow run. If you see a state-file conflict in PRs or weird behavior:
1. Pull latest: `git pull --rebase`
2. Compare local state files against `origin/main` — the remote is authoritative for the bot's "memory"
3. Don't manually edit state files unless you know exactly what you're doing — the bots reason about open contracts and seen disclosures via these files

### Rolling back to local routines

The 3 local Claude routines are **disabled**, not deleted. To roll back:
1. Disable the GitHub Actions workflows: GitHub → Actions → each workflow → ⋯ → "Disable workflow"
2. Re-enable the local routines via `mcp__scheduled-tasks__update_scheduled_task` with `enabled: true` (IDs: `tsla-strategy-monitor`, `congress-copy-disclosures`, `tsla-wheel-daily-summary`)
3. Cleanup window: keep both disabled for 30 days as a fallback. Delete after 30 clean days.

## Wheel strategy research tools (free)

For evaluating new stocks before adding to the wheel:

| Tool | Best for |
|---|---|
| **barchart.com** | IV rank, options volume, screening |
| **marketchameleon.com** | IV percentile, earnings dates, options stats |
| **finviz.com** | Stock screener by sector, price, volatility |
| **unusualwhales.com** | Big options activity, unusual flow |
| **finance.yahoo.com** | Quick options chain check, earnings calendar |

**Criteria for a wheelable stock:**
1. You'd be happy owning 100 shares of it if assigned
2. High implied volatility (IV) — fatter premiums
3. Liquid options market — tight bid-ask spreads
4. Price that fits buying power (strike × 100 = cash needed)
5. No earnings in the next 2–4 weeks before selling a contract

## Future work (revisit week of May 5–12, 2026)

- **Wheel stock screener** — automate the criteria above into a "wheel score" tool. Don't build until TSLA wheel has 1–2 weeks of clean hosted operation.
- **Multi-stock strategy expansion** — generalize `strategy.py` and `wheel_strategy.py` past TSLA-only. Trail stop/ladder is the easier piece (just iterate open positions). Wheel needs a curated "wheelable" list before it can be generalized.
- **Politician roster review** — after a few weeks, evaluate which of the 4 politicians actually produced fillable copy trades. Drop dead weight, add active newcomers.
- **Bump GitHub Actions versions** — `actions/checkout@v4` and `actions/setup-python@v5` use Node 20 which gets phased out 2026-09-16. Bump before then.

## API notes

- Auth headers: `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`
- Orders placed pre-market or after-hours queue for next regular session open
- Yahoo (YHOO) is not publicly traded — private company since 2021
- Wheel option positions take a brief moment after market open to fill — the wheel's `_resolve_pending_contract` helper distinguishes "still pending" from "contract gone" via order status
