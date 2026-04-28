# Congress Copy Trading Bot — Design Spec

**Date:** 2026-04-25
**Status:** Approved (awaiting user spec review)
**Owner:** Tim (fattycodes@gmail.com)

## 1. Purpose

Build an automated paper-trading bot that copies the disclosed stock and options trades of US Representative **Josh Gottheimer (D-NJ)** via the Alpaca paper trading API, using publicly disclosed STOCK Act filings sourced from CapitolTrades.com. The goal is to test whether copy-trading a high-frequency politician produces meaningful returns despite the inherent disclosure lag.

Lives as a new sibling subfolder `congress-copy/` inside the existing `TradingBotTest-Claude/` project; does not affect the existing `strategy.py`.

## 2. Strategic Caveats (Acknowledged Up Front)

- **Disclosure lag is the dominant headwind.** STOCK Act gives 45 days to disclose. Every signal we act on is by definition 1–6 weeks stale. This is an experiment to *measure* whether residual edge survives the lag — not a strategy expected to crush the S&P.
- **Past performance ≠ tradeable alpha.** Top-performer leaderboards reflect trades made when prices were different from where we'll be entering.
- **Options replication is approximate.** The exact contract Gottheimer traded is often unavailable by the time we copy. We accept this and use a cascading fallback (see §6).
- **CapitolTrades has no public API.** We scrape with Playwright. Brittle by nature; failures fall back to no-op + log.
- **Paper trading only.** A startup guard refuses to run against any URL other than `paper-api.alpaca.markets`.

## 3. Decisions Made During Brainstorm

| Decision | Choice | Rationale |
|---|---|---|
| Politician | Josh Gottheimer (D-NJ, House) | Most active member of Congress: 1,423 trades / $185.76M volume in last 6 months. Maximizes signal frequency for a paper-trading test. |
| Data source | Scrape CapitolTrades via Playwright | Free; same source used for picking the politician. Accept fragility tradeoff. |
| Asset classes | Stocks, ETFs, AND options | User wants full-fidelity copy. |
| Position sizing | Tiered by disclosed dollar range | Captures conviction signal without needing his actual portfolio size. |
| Options fallback | Cascade: exact contract → similar contract → underlying stock → skip | Maximum fidelity with graceful degradation. Every fallback decision logged. |
| Sell logic | Mirror his sells + -15% stop-loss | Lets winners run, floors losses since disclosure lag prevents fast reaction. |
| Schedule | Disclosure check every 6h; stop-loss check every 30 min during market hours | Disclosure lag makes hourly polling wasteful; 30-min stop-loss is tight enough. |
| Subfolder name | `congress-copy/` | Future-proof if politician swap or basket strategy is added later. |

## 4. Architecture

```
congress-copy/
├── .env.example          # template (real .env stays at project root)
├── README.md             # quick-start docs
├── requirements.txt      # python deps (httpx, playwright, schedule, pytest, etc.)
├── config.py             # tunable knobs (politician slug, sizing tiers, stop-loss %)
├── src/
│   ├── scraper.py        # CapitolTrades scraper (Playwright) → list[Disclosure]
│   ├── alpaca_client.py  # thin wrapper over Alpaca paper API
│   ├── sizing.py         # tiered sizing logic (range → dollar amount)
│   ├── options_resolver.py  # cascading fallback for options trades
│   ├── trader.py         # orchestrates: disclosures → orders
│   ├── monitor.py        # checks open positions, fires stop-loss sells
│   ├── state.py          # SQLite-backed bookkeeping
│   └── runner.py         # entrypoint with subcommands
├── tests/
│   ├── test_sizing.py
│   ├── test_options_resolver.py
│   ├── test_state.py
│   └── test_integration.py
├── data/
│   └── state.db          # SQLite (gitignored)
└── logs/
    └── *.log             # rotating logs (gitignored)
```

### Module responsibilities

Each unit has **one job**, communicates through plain dataclasses, and can be tested in isolation.

- **`scraper`** — only knows about CapitolTrades HTML. Returns `list[Disclosure]`. Knows nothing about Alpaca, sizing, or state.
- **`alpaca_client`** — only knows about Alpaca's REST API. Order submission, position queries, market clock checks. Knows nothing about politicians or scrapers.
- **`sizing`** — pure function: `(range_low, range_high) → dollar_amount`. No I/O. Easiest unit to test.
- **`options_resolver`** — given a disclosed options trade, returns an executable `OrderIntent` (or `None`) using the cascading fallback. Talks to `alpaca_client` only to query available contracts.
- **`trader`** — the brain. Pulls disclosures, filters unseen ones, asks `sizing` for amounts, asks `options_resolver` for option intents, submits orders via `alpaca_client`, records results via `state`.
- **`monitor`** — independent loop. Reads positions from `alpaca_client`, reads entries from `state`, closes positions that breach `STOP_LOSS_PCT`.
- **`state`** — only thing that touches SQLite. Tables: `seen_disclosures`, `positions`, `fallback_decisions`, `events`.
- **`runner`** — CLI entrypoint: `python -m congress_copy.runner disclosures` or `... monitor`.

## 5. Data Flow

### 5.1 Disclosure path (every 6 hours)

```
runner.py disclosures
   │
   ├─► scraper.fetch_recent_disclosures("josh-gottheimer")
   │     └─► Playwright → capitoltrades.com/politicians/<id>
   │           returns: [Disclosure(trade_id, ticker, side, range_low, range_high,
   │                                filed_at, traded_at, asset_kind, option_details?)]
   │
   ├─► state.filter_unseen(disclosures)
   │     └─► drops disclosures we've already acted on (keyed by trade_id)
   │     └─► drops disclosures with filed_at older than 7 days (stale cutoff)
   │
   ├─► for each new disclosure:
   │     ├─► sizing.compute(disclosure.range_low, range_high) → dollar_amount
   │     ├─► if asset_kind == "option":
   │     │     options_resolver.resolve(disclosure, dollar_amount) → OrderIntent | None
   │     │   else:
   │     │     OrderIntent(ticker, side, dollar_amount)
   │     │
   │     ├─► alpaca_client.submit(order_intent)
   │     └─► state.record(disclosure, order_intent, fill_result, fallback_path)
   │
   └─► log structured summary: {new: X, ordered: Y, skipped: Z, errors: W}
```

### 5.2 Monitor path (every 30 min during market hours)

```
runner.py monitor
   │
   ├─► alpaca_client.is_market_open() → bool   # short-circuit if closed
   ├─► alpaca_client.list_positions()
   │
   ├─► for each position:
   │     ├─► entry_price = state.get_avg_entry(position.symbol)
   │     │     # cost-basis weighted average if multiple buys of same ticker
   │     ├─► drawdown = (current_price - entry_price) / entry_price
   │     └─► if drawdown <= STOP_LOSS_PCT:
   │           alpaca_client.close_position(symbol)
   │           state.mark_stopped_out(symbol, current_price, drawdown)
   │
   └─► log structured summary: {checked: N, stopped_out: M}
```

### 5.3 Idempotency

`state.filter_unseen` uses CapitolTrades' stable `trade_id` as the dedupe key. Re-running the disclosure job 100× in a row results in zero duplicate orders.

## 6. Options Fallback Cascade

When `asset_kind == "option"`, `options_resolver` tries in order:

1. **Exact contract match** — same ticker, same option type (call/put), same strike, same expiry. Available and liquid (open interest > 0)? Use it. Stop.
2. **Similar contract match** — same ticker, same type, expiry ≥ `OPTIONS_MIN_DAYS_TO_EXPIRY` days out, strike within `OPTIONS_MAX_STRIKE_DEVIATION_PCT` of original. Available and liquid? Use it. Stop.
3. **Underlying stock fallback** — if `OPTIONS_UNDERLYING_FALLBACK == True`, buy the underlying stock with the sized dollar amount. Direction matches: a call → long stock, a put → short stock (or skip if shorting unavailable).
4. **Skip** — log `OPTION_UNRESOLVABLE` with full disclosure details and the reason each prior step failed.

**Every cascade decision is recorded in `fallback_decisions` table** so the user can grep for "this option got substituted with that stock because X".

## 7. Configuration (`config.py` defaults)

```python
# Who we're copying
POLITICIAN_SLUG = "josh-gottheimer"
POLITICIAN_NAME = "Josh Gottheimer"

# Position sizing tiers: (max_range_high_usd, dollars_to_commit)
SIZING_TIERS = [
    (15_000,       500),
    (50_000,     1_000),
    (100_000,    2_000),
    (250_000,    3_000),
    (1_000_000,  4_000),
    (float("inf"), 5_000),
]

# Risk management
STOP_LOSS_PCT = -0.15

# Options fallback
OPTIONS_MIN_DAYS_TO_EXPIRY = 30
OPTIONS_MAX_STRIKE_DEVIATION_PCT = 0.10
OPTIONS_UNDERLYING_FALLBACK = True

# Schedule
DISCLOSURE_CHECK_HOURS = [6, 12, 18, 23]  # 4× daily, US/Central (user's home tz)
MONITOR_INTERVAL_MINUTES = 30              # market hours only

# Safety rails
MAX_OPEN_POSITIONS = 50
MAX_DAILY_TRADES = 20
STALE_DISCLOSURE_CUTOFF_DAYS = 7
PAPER_ONLY_GUARD = True
```

### Sizing example on $50K paper account

| Disclosed range | Tier | Commit |
|---|---|---|
| $1K–$15K | 1 | $500 |
| $15K–$50K | 2 | $1,000 |
| $50K–$100K | 3 | $2,000 |
| $100K–$250K | 4 | $3,000 |
| $250K–$1M | 5 | $4,000 |
| $1M+ | 6 | $5,000 |

### `PAPER_ONLY_GUARD`

On every startup, the runner checks `os.environ["ALPACA_BASE_URL"]`. If it does not exactly equal `https://paper-api.alpaca.markets/v2`, the process exits with a loud red error before any network calls. Non-negotiable.

## 8. Error Handling Matrix

| Scenario | Behavior |
|---|---|
| CapitolTrades HTML changes / scraper breaks | Returns empty list + logs `PARSE_ERROR` with offending HTML snippet. No trades. Retries next cycle. |
| Alpaca API 5xx / network error | Exponential backoff retry: 1s, 2s, 4s, 8s, 16s. Then mark order `PENDING_RETRY` in state, attempt next cycle. |
| Market closed when disclosure check fires | Submit as Day order; queues for next open. No pre/post-market handling in v1. |
| Ticker delisted / halted | Catch Alpaca rejection, log `TICKER_UNAVAILABLE`, mark disclosure `SKIPPED_DELISTED`. Won't retry. |
| Insufficient buying power | Log `NO_BUYING_POWER`, mark `SKIPPED_NO_CASH`. Don't liquidate other positions. |
| Option contract not found | Cascade through fallback (§6). Log every step. |
| Stop-loss check on weekend/holiday | `is_market_open()` short-circuits the run cleanly. |
| Duplicate disclosure on CapitolTrades | `state.filter_unseen` silently dedupes by `trade_id`. |
| Bot starts after extended downtime | Fetch disclosures since `last_seen_filed_at`. Skip anything older than `STALE_DISCLOSURE_CUTOFF_DAYS` (7 days) to avoid trading 2-month-old news. |
| `.env` missing / wrong base URL | `PAPER_ONLY_GUARD` exits before any network calls. |
| Two runner instances active | SQLite file lock + `data/runner.lock` PID file. Second instance exits cleanly with "another runner is active". |
| `MAX_DAILY_TRADES` exceeded | Log `CIRCUIT_BREAKER_TRIPPED`, halt trading until next calendar day. Monitor still runs. |
| `MAX_OPEN_POSITIONS` exceeded | Log `MAX_POSITIONS_REACHED`, skip new buys but continue stop-loss enforcement. |

**No silent failures.** Every error path either retries with backoff or writes a structured `events` row with `event_type`, `disclosure_id`, and `reason`. Logs are greppable.

**No automated alerts in v1.** User reviews logs manually. Discord/email notifications are deferred to phase 2.

## 9. Testing

### 9.1 Unit tests (pytest, no network)

- `test_sizing.py` — every tier boundary, $0, negative, missing range, range_low > range_high
- `test_options_resolver.py` — exact match, similar match, fallback to underlying, total skip; bull call → long stock, bull put → short stock or skip
- `test_state.py` — `filter_unseen` idempotency, position bookkeeping, stale-cutoff filter, dedupe under concurrent writes

### 9.2 Integration tests (mock Alpaca + stubbed scraper)

- Disclosure → order submitted with right size and side
- Stop-loss triggers when mocked price drops below threshold
- Duplicate disclosure does not double-order
- `PAPER_ONLY_GUARD` blocks startup with non-paper URL
- Daily trade limit halts trading mid-cycle

### 9.3 Live smoke test

After unit + integration pass, run one disclosure cycle against the real Alpaca paper API. Confirm an actual order shows up in the Alpaca dashboard. Manual verification step.

### 9.4 Explicitly NOT tested

The Playwright scraper itself. HTML changes — scraper tests would be brittle and would lull us into false confidence. Right monitoring is the `PARSE_ERROR` log entry plus the user's manual review of daily summaries.

## 10. Performance Tracking

A separate `report.py` script (run on demand, no schedule) reads from `data/state.db` and emits:

- Total return % vs S&P 500 benchmark over the same window (uses Alpaca's `SPY` quotes)
- Per-trade P&L: win/loss/open
- Average hold time (entry → exit)
- Stop-loss trigger rate (saved us vs triggered before rebound)
- Lag-cost analysis: estimated returns if we'd entered at `traded_at` vs actual entry at `filed_at + our_polling_delay`
- Fallback distribution: how often did we get exact contract / similar / underlying / skip on options?

User runs `python report.py` whenever they want a snapshot. CSV export available for spreadsheet analysis.

## 11. Out of Scope (v1)

- Live trading (paper only, hard-enforced)
- Multiple politicians or basket strategies (single politician is config; basket would need new architecture)
- Take-profit logic (user explicitly chose stop-loss only)
- Discord / email / SMS notifications
- A web dashboard (logs and `report.py` are sufficient)
- Tax-lot accounting / tax reporting
- Margin / leverage usage (paper account stays cash)

## 12. Success Criteria

1. Bot runs unattended for 30 days without crashing.
2. Every disclosure-to-order decision is traceable in logs.
3. After 30 days, `report.py` produces a meaningful comparison vs S&P 500 — even if the result is "this strategy doesn't work," that's a successful experiment.
4. Zero accidental live-account orders (guaranteed by `PAPER_ONLY_GUARD`).

---

## Appendix: Open Questions Deferred to Implementation Plan

- Exact Playwright scraping selectors (will be derived during implementation)
- SQLite schema column types (will be defined in `state.py`)
- Logging library choice (`logging` stdlib vs `structlog` — implementation detail)
- Whether to use `asyncio` or threading for the schedule loop (likely `schedule` lib + threading for simplicity)
