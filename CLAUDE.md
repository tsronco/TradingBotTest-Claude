# TradingBotTest-Claude

Alpaca paper trading sandbox running scheduled bots on **GitHub Actions cron** across **three paper accounts in parallel** — a "conservative" and "aggressive" wheel that auto-execute, plus a "manual" account where the user opens trades by hand and the bot manages them (trail/ladder/stop on every stock you hold, 50% close on existing puts, covered call sale on assignment) but never opens new puts itself. Notifications flow to a private Discord server (separate channels per account); structured logs are committed back to this repo as JSONL.

A **personal web dashboard** at `dashboard/` (Vite + React 19 + Tailwind v4, deployed to Vercel at https://tradingbot-dashboard-blue.vercel.app) sits alongside the bots — read-only-monitoring + manual lookup of any symbol. See [Dashboard subproject](#dashboard-subproject) below.

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
│  tsla-monitor-aggressive.yml  (every 10 min, :9 offset)           │
│    ├─ strategy.py --mode aggressive                                │
│    ├─ wheel_strategy.py --mode aggressive  (5% OTM, 7-14 DTE,     │
│    │                                       60% close, +crypto)    │
│    └─ long_options_strategy.py --mode aggressive                  │
│  wheel-screener-aggressive.yml (Sundays 6:02pm ET — high-IV pool) │
│  Discord: #aggressive-trades, #aggressive-summary,                │
│           #aggressive-errors, #aggressive-actions                 │
│  Alpaca:  ALPACA_AGG_API_KEY / ALPACA_AGG_API_SECRET              │
└────────────────────────────────────────────────────────────────────┘

┌─ Manual paper account ────────────────────────────────────────────┐
│  tsla-monitor-manual.yml      (every 10 min, :11 offset)          │
│    ├─ strategy.py --mode manual                                    │
│    │   auto-discovers stocks from positions; trail/ladder/stop    │
│    │   on every name held (not just TSLA); ladder qty scales      │
│    │   to initial_position_qty × {0.8, 1.2, 2.0}                  │
│    ├─ wheel_strategy.py --mode manual                              │
│    │   wheel_skip_new_puts=True (never opens Stage 1); adopts     │
│    │   user-opened puts/CCs from positions and manages them       │
│    │   with conservative wheel params (50% close, sells CC on     │
│    │   assignment)                                                 │
│    └─ long_options_strategy.py --mode manual                       │
│        manages exits on long options the user bought manually     │
│  wheel-screener-manual.yml    (Sundays 6:04pm ET — IDEAS only,    │
│                                 default conservative universe)    │
│  Discord: #manual-trades, #manual-summary,                        │
│           #manual-errors, #manual-actions                         │
│  Alpaca:  ALPACA_MANUAL_API_KEY / ALPACA_MANUAL_API_SECRET        │
│  Starting capital: $10k (vs $100k on the auto-execute accounts)   │
└────────────────────────────────────────────────────────────────────┘

┌─ Shared workflows ────────────────────────────────────────────────┐
│  congress-copy.yml      (Mon–Fri, 4× day)                         │
│    Conservative-only: scrapes politicians, copies trades, -15% SL │
│  daily-summary.yml      (4:12 PM ET Mon–Fri — combined report)    │
│    1. Conservative summary  → #daily-summary                      │
│    2. Aggressive summary    → #aggressive-summary                 │
│    3. Manual summary        → #manual-summary  (no head-to-head)  │
│    4. Head-to-head embed    → cons + agg summary channels         │
│       (manual excluded — different starting capital and operating │
│        model make a 3-way comparison apples-to-oranges)           │
└────────────────────────────────────────────────────────────────────┘
```

The three accounts run **identical scripts** parameterized by `--mode`. The mode picks credentials, state files, log streams, Discord channels, wheel symbols, and parameters from `config.py → MODES`. Manual mode adds two extra flags (`auto_discover_symbols` and `wheel_skip_new_puts`) that change behaviour without forking the scripts. Tests cover that the three modes are properly isolated (separate Alpaca creds, distinct state files, distinct Discord channels) and that manual's behaviour flags fire correctly.

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

# Manual paper account
ALPACA_MANUAL_API_KEY=...
ALPACA_MANUAL_API_SECRET=...
ALPACA_MANUAL_BASE_URL=https://paper-api.alpaca.markets/v2

# Discord webhooks — manual side
DISCORD_MANUAL_TRADES_WEBHOOK=...
DISCORD_MANUAL_SUMMARY_WEBHOOK=...
DISCORD_MANUAL_ERRORS_WEBHOOK=...
DISCORD_MANUAL_ACTIONS_WEBHOOK=...
```

**Paper trading only.** Base URL must stay as `paper-api.alpaca.markets`. The `paper_guard.py` module asserts this on every congress-copy invocation.

## Scheduled workflows

All cron expressions are in **UTC**. Times below are translated for clarity.

All eight workflows are triggered **exclusively by cron-job.org** via `workflow_dispatch` API calls. The schedules are configured in cron-job.org's account (see `tools/setup_cronjobs.py` for the canonical source).

| Workflow | cron-job.org schedule (UTC) | CT | ET | Covers |
|---|---|---|---|---|
| `tsla-monitor.yml` | `7,17,27,37,47,57 13-20 * * 1-5` | every 10 min, 8:07 AM–3:57 PM | every 10 min, 9:07 AM–4:57 PM | Conservative: strategy + wheel + long-options |
| `tsla-monitor-aggressive.yml` | `9,19,29,39,49,59 13-20 * * 1-5` | every 10 min, :09 offset | every 10 min, :09 offset | Aggressive: strategy + wheel + long-options |
| `tsla-monitor-manual.yml` | `1,11,21,31,41,51 13-20 * * 1-5` | every 10 min, :11 offset | every 10 min, :11 offset | Manual: strategy + wheel + long-options |
| `congress-copy.yml` | `7 13,15,17,19 * * 1-5` | 8:07/10:07/12:07/2:07 PM | 9:07/11:07/1:07/3:07 PM | Conservative-only: scrape + monitor |
| `daily-summary.yml` | `12 20 * * 1-5` | 3:12 PM | 4:12 PM | 4-step: cons + agg + manual + head-to-head |
| `wheel-screener.yml` | `0 22 * * 0` | 5:00 PM Sun | 6:00 PM Sun | Conservative wheel-candidate digest |
| `wheel-screener-aggressive.yml` | `2 22 * * 0` | 5:02 PM Sun | 6:02 PM Sun | Aggressive (high-IV) wheel-candidate digest |
| `wheel-screener-manual.yml` | `4 22 * * 0` | 5:04 PM Sun | 6:04 PM Sun | Manual wheel-candidate digest (IDEAS only — bot doesn't execute) |

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

Manual side:

| Channel | What lands there | Phone notification setting |
|---|---|---|
| `#manual-trades` | Manual-account trail/ladder/stop fires + wheel adoptions, 50% closes, CC sales | (your choice) |
| `#manual-summary` | 4:12 PM ET manual summary (no head-to-head — different starting capital and operating model) | All messages (push) |
| `#manual-errors` | Manual-account errors / exceptions | All messages (push, with @mention) |
| `#manual-actions` | Manual firehose for one-scroll review | Muted |

**If `#errors`, `#aggressive-errors`, and `#manual-errors` all stay empty all day, the system worked.**

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
- **Aggressive**: priority tier (COIN, MARA, RIOT, SMCI, NVDA, AMD, MU) + fallback tier (TSLA, BAC, XOM, KO, PLTR, SOFI, PFE) = 14 symbols. 5% OTM puts, 7-14 DTE, 60% close.
- **Manual**: no static symbol list — auto-discovers from Alpaca positions every cycle. Wheel parameters mirror conservative (10% OTM, 14-28 DTE, 50% close) but the wheel **never opens new puts**; it only manages existing user-opened positions and sells covered calls when one of those puts gets assigned.

> 📌 **Heads-up: symbol order = fill priority.**
> The wheel iterates `SYMBOLS` sequentially and consumes buying power as it places put orders. Symbols listed *earlier* in the list get first claim on cash; later symbols only fill if BP remains.
>
> - **Conservative** has plenty of headroom for 10 puts on a $100k account — order doesn't matter much. Adjust freely.
> - **Aggressive** is BP-constrained on $100k with 14 symbols. The intentional order is **priority tier first, fallback tier second** — the high-IV names (COIN/MARA/RIOT/SMCI/NVDA/AMD/MU) take BP before the boring core (TSLA/BAC/XOM/etc.) gets a turn.
>
> **When adding or removing symbols:** put new ones where you want them in the fill order.
> For aggressive, that usually means *front of list = "I really want this filled"*, *end of list = "fill if you can, otherwise no big deal"*. The comments in `config.py` mark the priority/fallback tier boundary explicitly so you can drop new symbols into the right group.
>
> Symbols that hit insufficient cash (i.e., the wheel tried but ran out of BP) silently skip and log to `#aggressive-actions` (muted firehose) rather than `#aggressive-errors`. That's intentional — running out of cash for the fallback tier in aggressive mode is *expected behavior*, not an error.

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

**Per-symbol error isolation**: if `BAC` errors out, `XOM`/`KO`/etc. still process normally. Failed symbols ping the mode's errors channel (`#errors` or `#aggressive-errors`) with the symbol name in the title.

**To add/remove symbols**: edit `CONSERVATIVE_SYMBOLS` or `AGGRESSIVE_SYMBOLS` in `config.py` (NOT in `wheel_strategy.py` — that file consumes the lists from config). The empty-state initializer handles new entries automatically on next cycle. **Where you place the symbol in the list controls fill priority** — see the heads-up box above.

### Manual mode — auto-discover, manage-only

Manual mode runs the same `strategy.py`, `wheel_strategy.py`, and `long_options_strategy.py` as the auto-execute accounts, but with two flags in `config.MODES["manual"]` that change behaviour:

- `auto_discover_symbols: True` — strategy and wheel build their symbol set from live Alpaca positions every cycle instead of iterating a static `wheel_symbols` list. The strategy treats every stock you hold as a trail/ladder/stop candidate (not just TSLA); the wheel manages every short option position you hold.
- `wheel_skip_new_puts: True` — `_sell_new_put` is a no-op. The bot never opens Stage 1 puts. It still does everything else: 50% close on existing puts, transition to Stage 2 when a put gets assigned, sell the covered call on the new shares, manage the call to expiry/early-close.

**First-sighting seed for the strategy:** when a new stock symbol appears in your manual positions, `_manual_seed_state()` adopts the position's current avg cost as the entry baseline. There's no "seed buy" step like the conservative TSLA flow — the bot picks up whatever you happen to hold and starts managing.

**Ladder qty scaling:** TSLA's hand-tuned 8/12/20 ladder against `INITIAL_QTY=10` defines the multipliers (`0.8 / 1.2 / 2.0`). Manual mode applies those multipliers to whatever quantity you initially hold: 5 shares ladders 4/6/10, 1 share ladders 1/1/2 (rounded to ≥1).

**Wheel adoption:** when the wheel sees a short option position on a symbol it doesn't already track, `_discover_wheel_state()` parses the OCC symbol, pulls the position's avg entry price as the per-share premium received, and seeds `sym_state` so `handle_stage1` (for puts) or `handle_stage2` (for pre-sold CCs) can run unchanged. A Discord embed announces the adoption.

**Position drift reconciliation:** `_manual_run_symbol()` checks Alpaca's qty/avg_cost on every cycle and adopts Alpaca's view when it differs from bot state (e.g., user added or sold shares manually between cycles). The stop is recalculated from the new avg cost.

**Closed positions are pruned:** if a symbol disappears from Alpaca and the bot's stored qty is 0, it's removed from state on the next cycle.

### Congress copy — `congress-copy/`
Tracks 4 politicians (`config.py → POLITICIANS`):
- **G000583 — Josh Gottheimer** (original)
- **P000197 — Nancy Pelosi** (very active historically)
- **T000278 — Tommy Tuberville** (frequent disclosures)
- **G000597 — Daniel Goldman** (newer member, fairly active)

Pulls disclosures from CapitolTrades, sizes positions by tier (`config.SIZING_TIERS`), submits paper orders, and runs an independent `-15%` stop-loss monitor on positions IT opened (won't touch TSLA shares or wheel options — verified via `state.get_avg_entry()` gate).

## Daily summary

`daily_summary.py` runs four steps each weekday at 4:12 PM ET (`daily-summary.yml` workflow):

1. **Conservative summary** (`--mode conservative`) — aggregates `strategy_state.json` + `wheel_state.json` + congress-copy SQLite + long-options positions. Posts an embed to `#daily-summary`.
2. **Aggressive summary** (`--mode aggressive`) — aggregates `strategy_state_aggressive.json` + `wheel_state_aggressive.json` + long-options positions. Posts to `#aggressive-summary`. (Congress-copy is conservative-only, so it's omitted here.)
3. **Manual summary** (`--mode manual`) — aggregates `strategy_state_manual.json` (multi-symbol format) + `wheel_state_manual.json` + long-options positions. Posts to `#manual-summary`. No head-to-head inclusion — different starting capital ($10k vs $100k) and a different operating model (user-driven entries) make a 3-way comparison apples-to-oranges.
4. **Head-to-head comparison** (`--head-to-head`) — pulls equity / cash / premium / cycles from the conservative + aggressive Alpaca accounts, builds a side-by-side table embed, and posts the same comparison to *both* `#daily-summary` and `#aggressive-summary` so each side's view shows the race.

End result: 5 embed cards per day across the three summary channels — one per-mode summary in each, plus the head-to-head in `#daily-summary` and `#aggressive-summary` (manual-summary stays standalone).

## Runbook — when something breaks

### `#errors` or `#aggressive-errors` is pinging — what do I do?

1. Open the most recent message. The embed includes the script name, exception type, and a snippet of the traceback. Note which side fired: conservative errors live in `#errors`, aggressive in `#aggressive-errors`.
2. If the error is in the **scraper** for one politician (e.g., "Pelosi" failed), the slug may be stale. Check `https://www.capitoltrades.com/politicians/<slug>` in a browser. If 404, find the correct slug and update `congress-copy/config.py → POLITICIANS`. (Congress-copy is conservative-only.)
3. If the error is **`order_rejected`**, check the reason text. Common causes: market closed, position not tradeable, weird strike that doesn't exist.
4. If a **workflow itself** failed (run shows red ✓ in https://github.com/tsronco/TradingBotTest-Claude/actions), open the run, find the failed step, read the log.

> 💡 **"Insufficient cash" is NOT in errors.** That goes to `#all-actions` / `#aggressive-actions` (muted firehose) by design — running out of buying power for a fallback-tier symbol in aggressive mode is the priority-ordering working as intended, not a bug. If you DO want to investigate a recurring insufficient-cash situation (e.g., on the conservative side), check the actions firehose or `logs/<mode>.jsonl`.

### A workflow didn't fire when expected

1. Check **https://github.com/tsronco/TradingBotTest-Claude/actions** — does the run appear?
2. GitHub Actions cron has a deterministic delay of a few minutes at dispatch time — a 13:00 UTC fire may actually run at 13:01–13:05 UTC.
3. If completely missing for ≥10 min past the scheduled time, GitHub may be having an outage. Workflows can be triggered manually: `gh workflow run <workflow-name>`.

### State file drift / "double-place" symptoms

State files (`strategy_state.json`, `strategy_state_aggressive.json`, `wheel_state.json`, `wheel_state_aggressive.json`, `congress-copy/data/state.db`) are committed back to the repo by each workflow run. If you see a state-file conflict in PRs or weird behavior:
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

Currently covered: every wheel state transition (Stage 1 ↔ Stage 2, pending/filled/assigned/expired/early-close, migration, empty-state init, insufficient-cash refusal); long-options decision logic; wheel-screener scoring; full mode-switching machinery (config.MODES integrity, parse_mode_arg, apply_mode in every script); manual-mode behaviour (skip-new-puts gate, ladder scaling, OCC parsing, auto-discovery, position adoption). 171 tests as of 2026-05-07.

The congress-copy package has its own pytest setup under `congress-copy/tests/` (run from inside that directory using its `.venv`).

## Future work

- **Wheel stock screener v1 shipped 2026-04-29** — runs separately for conservative (`wheel-screener.yml`) and aggressive (`wheel-screener-aggressive.yml`) on Sunday evenings. **Open improvements:** add earnings-date filter (currently a manual-check footer note), expand universes, add IV-rank component to the score (would need historical IV data — yfinance dep or manual cache).
- **Dual-mode paper architecture shipped 2026-04-29** — conservative + aggressive paper accounts running side-by-side with priority-tier symbol ordering on aggressive. **Open improvements:** seed an aggressive TSLA strategy state file once the aggressive account holds 10 TSLA shares; otherwise `strategy.py --mode aggressive` no-ops with "no state file" until then. Daily summary head-to-head will get more interesting once both accounts have ~1 week of fills to compare.
- **Multi-stock strategy expansion** — generalize `strategy.py` past TSLA-only. Trail stop/ladder is the easier piece (just iterate open positions). Wheel is already multi-stock as of 2026-04-28.
- **Politician roster review** — after a few weeks, evaluate which of the 4 politicians actually produced fillable copy trades. Drop dead weight, add active newcomers.
- **Bump GitHub Actions versions** — `actions/checkout@v4` and `actions/setup-python@v5` use Node 20 which gets phased out 2026-09-16. Bump before then.

## API notes

- Auth headers: `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`
- Orders placed pre-market or after-hours queue for next regular session open
- Yahoo (YHOO) is not publicly traded — private company since 2021
- Wheel option positions take a brief moment after market open to fill — the wheel's `_resolve_pending_contract` helper distinguishes "still pending" from "contract gone" via order status

## Dashboard subproject

A personal web dashboard at `dashboard/` — Vite + React 19 + Tailwind v4 SPA, deployed to Vercel. **Phase 1 shipped 2026-05-02. Phase 2 (manual trading + AI grading) shipped 2026-05-03.**

- Live: https://tradingbot-dashboard-blue.vercel.app
- Spec: `docs/superpowers/specs/2026-05-02-trading-dashboard-design.md`
- Phase 1 plan (executed): `docs/superpowers/plans/2026-05-02-trading-dashboard-phase1.md`
- Phase 2 plan (executed): `docs/superpowers/plans/2026-05-03-trading-dashboard-phase2.md`

### Phase 1 deliverable (shipped, all working)

- Auth: hardcoded password + TOTP + 8 single-use backup codes + KV-backed rate limiting (5 fails / 15 min)
- Bot-state push contract: each of `tsla-monitor.yml`, `tsla-monitor-aggressive.yml`, `congress-copy.yml` POSTs state JSON to `/api/bot-state` after its bot scripts run; bearer-auth via `BOT_PUSH_TOKEN`; fire-and-forget so bots are unaffected if dashboard is down
- Read-only pages: Home (dual-account snapshot + equity-curve sparklines w/ 1D/1W/1M/3M/1Y selector), Positions (stocks + options w/ all 5 Greeks + DTE + wheel-close % progress), Orders (open + filled w/ DTE)
- Lookup page (`/lookup/:symbol`): TradingView Advanced Chart, options chain w/ 25 expirations (MM/DD/YYYY dropdown, puts/calls/both filter, 6-strikes-nearest default, all 5 Greeks toggle), Robinhood-style earnings bars (yfinance), fundamentals (yfinance), wheelability scorer (with explicit messaging when markets closed), news (Alpaca), watchlist add
- Account selector (Both / Conservative / Aggressive) syncs across all components via custom event
- ErrorBoundary wraps every Lookup panel (no more whole-page blanking on a single component error)
- 34 vitest tests (auth flows, KV whitelist, TOTP, sessions, option-symbol parsing)

### Phase 2 deliverable (shipped 2026-05-03, validated end-to-end on Alpaca paper)

- Settings page (`/settings`): tabs for thresholds (per-account TOTP trigger amounts), tags (add/rename/delete), recovery (backup-code regeneration)
- Order form (`/order/new`): context-driven (stock vs. option detected from URL params), vertical stack layout, all order types (market/limit/stop/stop-limit/trailing for stocks; limit/market for options), account selector (conservative_paper / aggressive_paper / live-disabled), live quote in page header, position context line, entry grade (A–F) required, reasoning textarea required, tag picker
- Two-state confirm modal: phosphor (green) below per-account threshold, amber + TOTP re-prompt above threshold
- Trade detail (`/trade/:id`): lightweight-charts v5 price chart with entry/exit markers, trade timeline, your-grade-vs-AI-grade side-by-side, calibration delta display
- Trades history (`/trades`): summary band (win rate, avg grade, AI calibration, total P&L) + filterable/sortable table
- Modify and cancel actions on `/orders` (modify price/qty via modal, cancel with confirm)
- AI grading via Sonnet 4.6 with prompt caching — plain-English no-jargon system prompt, grades on close using entry context + price action
- Auto-grade cron (`*/5 13-20 * * 1-5` UTC) via cron-job.org — hits `POST /api/cron/grade-open-trades`
- 97 vitest tests total at end of Phase 2; bumped to 114 in the manual-account expansion (third paper account wired through the full dashboard surface)

### Architecture

```
dashboard/
├── api/                    # 9 of 12 Vercel serverless functions used (Hobby plan limit is 12)
│   ├── _lib/              # shared helpers (NOT functions — _ prefix excludes from routing)
│   │   ├── kv.ts          # @upstash/redis singleton + getJson/setJson
│   │   ├── kv-keys.ts     # whitelist of allowed bot-state keys + KV_KEYS map
│   │   ├── totp.ts        # otplib v12 — verifyTotp(code, secret) → boolean (sync)
│   │   ├── session.ts     # HMAC-signed session cookies (Node stdlib crypto)
│   │   ├── auth-guard.ts  # requireAuth(req, res) + getSession(req)
│   │   ├── alpaca.ts      # createClient factory, mode-aware
│   │   ├── data-api.ts    # alpacaData() + alpacaTrade() + alpacaTradeMutation() — bypass SDK bug
│   │   ├── rate-limit.ts  # KV-backed login lockout
│   │   ├── backup-codes.ts # SHA-256 hashed, single-use, KV-tracked
│   │   ├── trade-types.ts  # shared TypeScript types for trades/grades/rules
│   │   ├── trade-ids.ts    # deterministic trade ID generation
│   │   ├── exposure.ts     # position-exposure calculator
│   │   ├── rule-check.ts   # pre-order rule checker (stub → active in Phase 3)
│   │   ├── grading.ts      # Sonnet 4.6 AI grading with prompt caching
│   │   └── fundamentals-fetch.ts # shared yfinance fetch logic
│   ├── auth/[action].ts   # login | logout | session
│   ├── alpaca/[endpoint].ts  # account | positions | orders | quote | chain | news | bars | equity-history | modify-order | cancel-order
│   ├── kv/[resource].ts   # bot-state (read) | watchlist (CRUD)
│   ├── bot-state.ts       # bot push webhook (bearer-auth, key whitelist)
│   ├── fundamentals.py    # yfinance Python edge function (curl_cffi for browser impersonation)
│   ├── fundamentals-proxy.ts # TS proxy that gates the Python with INTERNAL_FUNCTIONS_TOKEN
│   ├── trades/[action].ts # preview | submit | list | get | close | grade
│   ├── settings/[resource].ts # thresholds | tags | backup-codes
│   └── cron/[job].ts      # grade-open-trades
├── src/
│   ├── routes/            # Login · Home · Positions · Orders · Lookup · OrderNew · TradeDetail · Trades · Settings
│   ├── components/        # auth · layout · account · lookup · order · trade · ErrorBoundary · Sparkline
│   ├── hooks/             # useAuth · useAccount · useBotState · useSettings
│   ├── lib/               # api · format · wheelability · option-symbol · trade-types · rule-check
│   └── styles/globals.css # Tailwind v4 with @theme block
├── tests/                 # 97 vitest tests
├── scripts/generate-backup-codes.ts
├── package.json · vite.config.ts · vitest.config.ts · tailwind.config.ts
├── postcss.config.js · tsconfig.{,app,node}.json
├── vercel.json · requirements.txt · .env.example
└── README.md · DEPLOY.md
```

### Vercel project + env vars

- Project: `tims-projects-f798c8a6/tradingbot-dashboard` (Hobby plan, Vite framework, root dir `dashboard/`)
- KV: `upstash-kv-red-canvas` (Upstash Redis via Vercel Marketplace)
- 21 production env vars set: `DASHBOARD_PASSWORD`, `TOTP_SECRET`, `SESSION_SECRET`, `BACKUP_CODES_HASHED`, `BOT_PUSH_TOKEN`, `INTERNAL_FUNCTIONS_TOKEN`, `ANTHROPIC_API_KEY` (Phase 2), `CRON_TOKEN` (Phase 2), 8 ALPACA_* (cons + agg + manual × 3), 5 KV_*/REDIS_URL (KV vars auto-injected by Marketplace)
- `.env` (local): also set `DASHBOARD_CRON_TOKEN` (mirrors `CRON_TOKEN` for local cron testing)
- GitHub Actions secret `BOT_PUSH_TOKEN` set on this repo (mirrors the Vercel value)

### Deploys

`npx vercel --prod` from the `dashboard/` directory. Git push does NOT auto-deploy. The first deploy was from local; subsequent ones go via the same command.

> **Worktree gotcha:** if you deploy from a fresh git worktree, `dashboard/.vercel/project.json` won't exist and `vercel --prod --yes` will silently create a new Vercel project named after the directory (`dashboard`) instead of linking to the existing `tradingbot-dashboard`. Always run `npx vercel link --yes --project tradingbot-dashboard` first when deploying from a new worktree.

### Cron schedule (cron-job.org)

| Job | jobId | Schedule (UTC) | Target |
|---|---|---|---|
| Dashboard — Grade Open Trades | 7557823 | `*/5 13-20 * * 1-5` | `POST /api/cron/grade-open-trades?job=grade-open-trades` w/ Bearer `${CRON_TOKEN}` |

### Known quirks (worth knowing before touching the dashboard code)

- **`@alpacahq/typescript-sdk@0.0.32-preview` ignores per-request `baseURL`.** Market data calls (snapshots, news, options snapshots, bars) bypass the SDK and use `alpacaData()` from `dashboard/api/_lib/data-api.ts`. The trading endpoints (account, positions, orders) use the SDK fine. The options-contracts endpoint is on the trading domain and uses `alpacaTrade()` (also bypasses SDK because the SDK strips `next_page_token`, breaking pagination). For non-GET trading calls (order placement, modify, cancel) use `alpacaTradeMutation()` — `alpacaTrade()` is GET-only.
- **TS strict-syntax rule:** `tsconfig.app.json` has `erasableSyntaxOnly: true` — no parameter properties (`constructor(public x: T)`), no enums, no value namespaces. Use explicit field declarations.
- **Tailwind v4 syntax:** `@theme` block in CSS, not `theme()` calls. v4 also auto-detects `content` glob; explicit config still works.
- **otplib v12** (NOT v13). v13 broke the `authenticator` namespace API.
- **Vercel Hobby 12-function limit** — currently at 9 of 12 used. Keep new endpoints inside existing catchalls where possible.
- **yfinance on Vercel** needs `curl_cffi` for browser impersonation + lxml for earnings; pinned in `requirements.txt` to specific versions that work (yfinance>=0.2.65, curl_cffi<0.8.0).
- **lightweight-charts v5 API:** use `addSeries(LineSeries)` not `addLineSeries()`; use `createSeriesMarkers` not `series.setMarkers()`. The v4 API is gone.
- **`trades:index:open` uses atomic Redis list ops** (`rpush`/`lrange`/`lrem`). Do not reintroduce read-modify-write patterns on that key — it will cause race conditions under concurrent grade-cron + submit traffic.

### Phase 3 (next) — known follow-ups from Phase 2 final review

- Auto-create follow-on stock trade when a STO is assigned (wheel completion loop)
- Server-side `live` account guard (currently only disabled client-side in the order form)
- DST-aware option-expiration detection in the grade-open-trades cron
- Activate the AI rule-checker (`rule-check.ts` is currently a stub that always passes)
- Tendency detection — surface recurring behavioral patterns across trades (e.g., "you consistently sell too early on TSLA")
- `/rules` page — view and manage the active rule set
- `/calendar` page — earnings / expiration calendar overlay
- `/performance` page — detailed P&L breakdown by symbol, strategy, tag
- Daily 4:15 PM coach's note (Phase 4) — AI-generated end-of-day behavioral summary
- PWA setup (Phase 4) — install prompt, offline shell, push notifications
