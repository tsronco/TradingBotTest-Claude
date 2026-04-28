# Congress Copy Trading Bot

Paper-trades the disclosed STOCK Act filings of Rep. Josh Gottheimer (D-NJ) via Alpaca paper API. Source data scraped from CapitolTrades.com.

**This is paper trading only.** A startup guard refuses to run against any Alpaca base URL other than `paper-api.alpaca.markets`.

## Quick start

Requires Python 3.12+ (developed on 3.14).

```bash
cd congress-copy
python -m venv .venv
source .venv/Scripts/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium

# Copy .env.example to project root .env and fill in your Alpaca paper keys
# Only run if ../.env doesn't already exist — do NOT overwrite a real key file
test -f ../.env || cp .env.example ../.env

# Run tests
pytest

# Run one disclosure check
python -m src.runner disclosures

# Run one stop-loss monitor pass
python -m src.runner monitor

# Generate performance report
python -m src.report
```

## Scheduling (Claude routines)

The bot is wired up as two Claude scheduled tasks (visible in the **Scheduled** sidebar):

- `congress-copy-disclosures` — fires at 06:00, 12:00, 18:00, 23:00 daily; runs `python -m src.runner disclosures` and reports the summary.
- `congress-copy-monitor` — fires every 30 min between 08:00 and 15:59 Mon–Fri; runs `python -m src.runner monitor` for stop-loss enforcement during market hours.

Manage either task from the Scheduled sidebar (pause, edit cron, run now, view history). Each run sends a notification with the JSON summary plus any errors.

To recreate them after deletion, ask Claude: *"create the congress-copy disclosures and monitor scheduled tasks"*.

See `docs/superpowers/specs/2026-04-25-congress-copy-bot-design.md` for full design.
