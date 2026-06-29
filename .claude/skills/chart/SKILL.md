---
name: chart
description: Historical price chart for a ticker (default 90 days). Overlays your average cost line if you hold the stock, and any open wheel strike lines from either account. Renders inline as a PNG. Read-only.
---

# /chart TICKER

Run `tools/chart.py` with the ticker. After it prints the `Chart: /tmp/chart_<TICKER>_<TS>.png` line, **Read that PNG** so the chart renders inline.

## Argument parsing

- `/chart TSLA` → 90 days
- `/chart NVDA 30` → 30 days
- `/chart WMT 180 days` → 180 days
- `/chart NVDA live` → use live account creds (data is the same; only matters for which account's positions show as overlays)

Map the day count to `--days N`. If the user includes "manual" or "live" (or "cons" / "agg"), pass `--mode`.

## How to run

```bash
python tools/chart.py <TICKER> [--days N] [--mode MODE]
```

## What NOT to do

- Don't predict where the price is going. The chart shows history, not a forecast.
- Don't refetch separately — the script does it in one pass.
