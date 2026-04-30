# TradingBotTest-Claude

Alpaca paper trading sandbox running scheduled bots on **GitHub Actions cron** across **two paper accounts in parallel** — a "conservative" and an "aggressive" wheel — to A/B-test wheel parameter aggressiveness in real market conditions. Notifications flow to a private Discord server (separate channels per account); structured logs are committed back to this repo as JSONL.

## Architecture at a glance

```
┌─ Conservative paper account ──────────────────────────────────────┐
│  tsla-monitor.yml             (every 10 min, 9 AM–5 PM ET)        │
│    ├─ strategy.py             (TSLA stock: trail + ladder)        │
│    ├─ wheel_strategy.py       (10% OTM, 14-28 DTE, 50% close)     │
│    └─ long_options_strategy   (manage long options)               │
│  wheel-screener.yml           (Sundays 6pm ET — large-cap pool)   │
│  Discord: #tsla-trades, #daily-summary, #errors, #all-actions     │
│  Alpaca:  ALPACA_API_KEY / ALPACA_API_SECRET                       │
└────────────────────────────────────────────────────────────────────┘

┌─ Aggressive paper account ────────────────────────────────────────┐
│  tsla-monitor-aggressive.yml  (every 10 min, :2 offset)           │
│    ├─ strategy.py --mode aggressive                                │
│    ├─ wheel_strategy.py --mode aggressive  (5% OTM, 7-14 DTE,     │
│    │                                       60% close, +crypto)    │
│    └─ long_options_strategy.py --mode aggressive                  │
│  wheel-screener-aggressive.yml (Sundays 6pm ET — high-IV pool)    │
│  Discord: #aggressive-trades, #aggressive-summary,                │
│           #aggressive-errors, #aggressive-actions                 │
│  Alpaca:  ALPACA_AGG_API_KEY / ALPACA_AGG_API_SECRET              │
└────────────────────────────────────────────────────────────────────┘

┌─ Shared workflows ────────────────────────────────────────────────┐
│  congress-copy.yml      (Mon–Fri, 4× day)                         │
│    Conservative-only: scrapes politicians, copies trades, -15% SL │
│  daily-summary.yml      (4:12 PM ET Mon–Fri — combined report)    │
│    1. Conservative summary  → #daily-summary                      │
│    2. Aggressive summary    → #aggressive-summary                 │
│    3. Head-to-head embed    → both summary channels               │
└────────────────────────────────────────────────────────────────────┘
```

The two accounts run **identical scripts** parameterized by `--mode`. The mode picks credentials, state files, log streams, Discord channels, wheel symbols, and parameters from `config.py → MODES`. Existing tests cover that the modes are properly isolated (separate Alpaca creds, distinct state files, distinct Discord channels).

## Environment

Credentials live in `.env` (gitignored). The same values are mirrored as **GitHub Actions secrets** for hosted runs.

```
# Conservative paper account
ALPACA_API_KEY=...
ALPACA_API_SECRET=...
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2

# Aggressive paper account (different paper account, same paper-api endpoint)
ALPACA_AGG_API_KEY=...
ALPACA_AGG_API_SECRET=...
ALPACA_AGG_BASE_URL=https://paper-api.alpaca.markets/v2

# Discord webhooks — conservative side
DISCORD_TSLA_WEBHOOK=https://discord.com/api/webhooks/...
DISCORD_CONGRESS_WEBHOOK=...
DISCORD_SUMMARY_WEBHOOK=...
DISCORD_ERRORS_WEBHOOK=...
DISCORD_ACTIONS_WEBHOOK=...

# Discord webhooks — aggressive side
DISCORD_AGG_TRADES_WEBHOOK=...
DISCORD_AGG_SUMMARY_WEBHOOK=...
DISCORD_AGG_ERRORS_WEBHOOK=...
DISCORD_AGG_ACTIONS_WEBHOOK=...
```

**Paper trading only.** Base URL must stay as `paper-api.alpaca.markets`. The `paper_guard.py` module asserts this on every congress-copy invocation.

## Scheduled workflows

All cron expressions are in **UTC**. Times below are translated for clarity.

All six workflows are triggered **exclusively by cron-job.org** via `workflow_dispatch` API calls. The schedules are configured in cron-job.org's account (see `tools/setup_cronjobs.py` for the canonical source).

| Workflow | cron-job.org schedule (UTC) | CT | ET | Covers |
|---|---|---|---|---|
| `tsla-monitor.yml` | `7,17,27,37,47,57 13-20 * * 1-5` | every 10 min, 8:07 AM–3:57 PM | every 10 min, 9:07 AM–4:57 PM | Conservative: strategy + wheel + long-options |
| `tsla-monitor-aggressive.yml` | `9,19,29,39,49,59 13-20 * * 1-5` | every 10 min, :09 offset | every 10 min, :09 offset | Aggressive: strategy + wheel + long-options |
| `congress-copy.yml` | `7 13,15,17,19 * * 1-5` | 8:07/10:07/12:07/2:07 PM | 9:07/11:07/1:07/3:07 PM | Conservative-only: scrape + monitor |
| `daily-summary.yml` | `12 20 * * 1-5` | 3:12 PM | 4:12 PM | 3-step: cons summary, agg summary, head-to-head |
| `wheel-screener.yml` | `0 22 * * 0` | 5:00 PM Sun | 6:00 PM Sun | Conservative wheel-candidate digest |
| `wheel-screener-aggressive.yml` | `2 22 * * 0` | 5:02 PM Sun | 6:02 PM Sun | Aggressive (high-IV) wheel-candidate digest |

**Why not GitHub's native `schedule:` trigger?** Two reasons:
1. **Reliability**: GitHub's cron didn't fire reliably on this repo's first day (multiple missed fires, even after going public and shifting off `:00`/`:30`).
2. **Race conditions**: when GitHub cron eventually started firing, it created a duplicate-scheduler race against cron-job.org. Both runs would update the same state files; the second would fail with merge conflicts. So we removed the native `schedule:` trigger entirely.

To change a schedule, update `tools/setup_cronjobs.py` and re-run it (it's idempotent — PATCHes existing jobs in place, creates any missing ones).

NYSE regular hours: 9:30 AM–4:00 PM ET = 13:30–20:00 UTC. Cron fires that fall outside market hours are handled correctly:
- **Wheel** has an `is_market_open()` guard that skips the cycle when market is closed (logs a JSONL heartbeat, doesn't touch state).
- **Strategy** runs anyway — it's just monitoring price, no order placement on heartbeat cycles.
- **Congress monitor** has a built-in market-closed early return.

⚠️ **DST changes**: cron values above are correct for **CDT** (March–November). When DST ends in early November, shift each UTC hour value +1.

## Discord channels

Conservative side:

| Channel | What lands there | Phone notification setting |
|---|---|---|
| `#tsla-trades` | Conservative wheel sells/closes/assignments + TSLA strategy fills | Mentions only |
| `#congress-trades` | Copy trades placed, congress stop-outs (conservative-only) | Mentions only |
| `#daily-summary` | 4:12 PM ET conservative summary + head-to-head comparison | All messages (push) |
| `#errors` | API failures, rejected orders, scraper crashes (conservative) | All messages (push, with @mention) |
| `#all-actions` | Conservative firehose for one-scroll review | Muted |

Aggressive side:

| Channel | What lands there | Phone notification setting |
|---|---|---|
| `#aggressive-trades` | Aggressive wheel sells/closes/assignments + strategy fills | (your choice) |
| `#aggressive-summary` | 4:12 PM ET aggressive summary + head-to-head comparison | All messages (push) |
| `#aggressive-errors` | Aggressive-account errors / exceptions | All messages (push, with @mention) |
| `#aggressive-actions` | Aggressive firehose for one-scroll review | Muted |

**If both `#errors` and `#aggressive-errors` stay empty all day, the system worked.**

## Strategies in detail

### TSLA stock — `strategy.py`
- **Entry**: 10 shares (already filled, avg cost in `strategy_state.json`)
- **Stop loss**: sell all if price drops 10% below current avg cost (recalculates after each ladder)
- **Trailing**: activates at +10% from entry; floor sits 5% below high-water mark, never moves down
- **Ladder 1**: −15% from entry → buy 8 more shares
- **Ladder 2**: −25% from entry → buy 12 more shares
- **Ladder 3**: −40% from entry → buy 20 more shares
- After each ladder: stop recalculates to `new_avg_cost × 0.90`

### Multi-stock wheel — `wheel_strategy.py`
Runs the wheel **independently on each stock in `SYMBOLS`** with isolated state per symbol. The symbol list and strategy parameters come from `config.MODES[mode]["wheel_symbols"]`:

- **Conservative**: TSLA, BAC, XOM, KO, PLTR, SOFI, PFE, F, T, INTC (10 large-caps + cheap names). 10% OTM puts, 14-28 DTE, 50% close.
- **Aggressive**: conservative core + COIN, MARA, RIOT, SMCI, NVDA, AMD, MU (14 symbols). 5% OTM puts, 7-14 DTE, 60% close.

- **Stage 1 — Cash-secured puts**:
  - Strike: ~10% below current stock price, rounded to nearest $5
  - Expiration: 2–4 weeks out (target ~3 weeks)
  - Cash check: only sell if `strike × 100 ≤ cash` (per stock, against shared account cash)
  - 50% profit rule: buy-to-close if option drops to half its entry premium
  - If assigned → 100 shares acquired → move to Stage 2
- **Stage 2 — Covered calls**:
  - Strike: ~10% above cost basis, rounded to nearest $5, **never below cost basis**
  - Expiration: 1–3 weeks out
  - 50% profit rule applies
  - If called away → back to Stage 1

**State file format** (`wheel_state.json` for conservative, `wheel_state_aggressive.json` for aggressive): top-level dict keyed by symbol, plus a `_meta` block. Legacy single-stock state (top-level `stage` key) is auto-migrated under the `TSLA` key on first load.

**Per-symbol error isolation**: if `BAC` errors out, `XOM`/`KO`/etc. still process normally. Failed symbols ping `#errors` with the symbol name in the title.

**To add/remove symbols**: edit the `SYMBOLS` list at the top of `wheel_strategy.py`. The empty-state initializer handles new entries automatically on next cycle.

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

## Running tests

Project root tests live in `tests/`. They mock all Alpaca API calls and clear Discord webhooks via `conftest.py`, so they never touch real services.

```bash
pip install -r requirements-dev.txt   # one-time
python -m pytest tests/ -v
```

Currently covered: every wheel state transition (Stage 1 ↔ Stage 2, pending/filled/assigned/expired/early-close, migration, empty-state init, insufficient-cash refusal).

The congress-copy package has its own pytest setup under `congress-copy/tests/` (run from inside that directory using its `.venv`).

## Future work (revisit week of May 5–12, 2026)

- **Wheel stock screener v1 shipped 2026-04-29** — `wheel_screener.py` posts a Sunday-evening digest to `#daily-summary`. **Open improvements:** add earnings-date filter (currently a manual-check footer note), expand universe beyond ~40 tickers, add IV-rank component to the score (would need historical IV data — yfinance dep or manual cache).
- **Multi-stock strategy expansion** — generalize `strategy.py` past TSLA-only. Trail stop/ladder is the easier piece (just iterate open positions). Wheel is already multi-stock as of 2026-04-28.
- **Politician roster review** — after a few weeks, evaluate which of the 4 politicians actually produced fillable copy trades. Drop dead weight, add active newcomers.
- **Bump GitHub Actions versions** — `actions/checkout@v4` and `actions/setup-python@v5` use Node 20 which gets phased out 2026-09-16. Bump before then.

## API notes

- Auth headers: `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`
- Orders placed pre-market or after-hours queue for next regular session open
- Yahoo (YHOO) is not publicly traded — private company since 2021
- Wheel option positions take a brief moment after market open to fill — the wheel's `_resolve_pending_contract` helper distinguishes "still pending" from "contract gone" via order status
