# TradingBotTest-Claude

Alpaca paper trading sandbox for testing trade execution, strategy development, and API integration.

## Environment

Credentials are stored in `.env` — never commit this file (it's in `.gitignore`).

```
ALPACA_API_KEY=...
ALPACA_API_SECRET=...
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2
```

**This is a paper trading account** — no real money involved. Base URL must stay as `paper-api.alpaca.markets` during testing.

## Scheduled Tasks

| Task | Schedule | Covers |
|---|---|---|
| `tsla-strategy-monitor` | Every 30 min, 8–3 CT, Mon–Fri | Trailing stop + ladder AND wheel strategy |
| `tsla-wheel-daily-summary` | 3:00 PM CT, Mon–Fri | Daily P&L report |
| `congress-copy-disclosures` | Every 2 hrs (8,10,12,2 PM CT), Mon–Fri | Disclosures + stop-loss monitor |

### ⚠️ Monday check: routine run counter
Check the Usage page (claude.ai/settings/usage → Additional features → Daily included routine runs).

- **If the counter increments** when tasks fire → we are drawing from the 15/day cap. Keep current frequencies.
- **If the counter stays at 0** → tasks do NOT count against the cap. Restore higher frequencies:
  - Split `tsla-strategy-monitor` back into two tasks:
    - Trailing stop monitor: every 10 min (`*/10 8-15 * * 1-5`)
    - Wheel monitor: every 15 min (`*/15 8-15 * * 1-5`)
  - Congress combined: can increase to every 30 min if desired

## Tuesday April 28 — Check Monday's First Run
On Tuesday, pull up the results from Monday's first live day and review:
- Did the routine run counter increment? (check claude.ai/settings/usage)
- Did `tsla-strategy-monitor` fire and catch the TSLA entry order fill?
- Did the TSLA wheel put order fill? What premium was collected?
- Did the congress-copy bot find any new Gottheimer disclosures?
- Did the 3 PM daily summary generate cleanly?
- Any errors in any task logs?
- Based on results: should we adjust frequencies, parameters, or strategy rules?

## Wheel Strategy Research Tools (free)
For finding and evaluating stocks to add to the wheel strategy:

| Tool | Best for |
|---|---|
| **barchart.com** | IV rank, options volume, screening |
| **marketchameleon.com** | IV percentile, earnings dates, options stats |
| **finviz.com** | Stock screener by sector, price, volatility |
| **unusualwhales.com** | Big options activity, unusual flow |
| **finance.yahoo.com** | Quick options chain check, earnings calendar |

**What to look for in a good wheel stock:**
1. You'd be happy owning 100 shares of it if assigned
2. High implied volatility (IV) — fatter premiums
3. Liquid options market — tight bid-ask spreads
4. Price that fits buying power (strike × 100 = cash you need)
5. No earnings in the next 2–4 weeks before selling a contract

## Pending Plans (review before building)

- **Hosted routines migration** — `docs/superpowers/plans/2026-04-26-hosted-routines-migration.md`
  - Move local scheduled tasks to GitHub Actions cron so bots run independently of laptop/Starlink state.
  - Covers: GitHub Actions hosting, multi-channel Discord webhooks, JSONL logging, daily email summary, Claude visibility setup, 5-phase migration.
  - Status: DRAFT — review either tonight or after Tuesday 4/28 results review. Don't build until TSLA strategies are validated working.
  - 6 open questions documented in the plan that need answering before implementation starts.

## Future Work (revisit week of May 5–12, 2026)

**Build a wheel stock screener** — a tool that takes a watchlist and automatically pulls IV rank, options liquidity, next earnings date, and current price for each stock. Outputs a "wheel score" so we can compare candidates at a glance. Don't build until after we've validated the TSLA wheel logic.

**Multi-stock strategy expansion** — currently both the trailing stop/ladder and wheel strategies are hardcoded to TSLA only. Goal is to generalize them so they cover any stock we're actively trading.

Key decisions needed before building:
- **Wheel strategy**: requires picking specific stocks you'd be happy owning if assigned (not just any stock). Need a list of "wheelable" stocks before this can be built.
- **Trailing stop/ladder**: could be applied to any position automatically — scan all open positions and protect each one. More straightforward to generalize.

Don't build this until we've seen at least 1–2 weeks of the current TSLA strategies running and validated the logic works.

## API Notes

- Auth headers: `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`
- Orders placed on weekends queue for Monday market open
- Yahoo (YHOO) is not publicly traded — private company since 2021
