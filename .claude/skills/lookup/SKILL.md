---
name: lookup
description: Wheel-focused snapshot of a stock — current price, near-term put candidates with bid/ask/Greeks/IV/open-interest, a wheelability score for the best setup, and an inline 90-day price chart. Read-only, no orders placed.
---

# /lookup TICKER

When the user invokes this skill, run `tools/lookup.py` with the ticker they provided and display the resulting report inline, followed by the chart.

## Argument parsing

The user may pass the ticker in various forms:
- `/lookup TSLA` → ticker `TSLA`
- `/lookup wmt` → ticker `WMT` (case-insensitive)
- `/lookup walmart` → resolve to `WMT` if it's an obvious match; otherwise ask the user to clarify
- `/lookup TSLA live` → ticker `TSLA`, mode `live`
- `/lookup NVDA --dte-min 7 --dte-max 14` → pass through as-is

If the user passes a company name instead of a ticker and you're confident of the mapping (e.g. "walmart" → WMT, "apple" → AAPL, "nvidia" → NVDA), use the ticker. If unsure, ask before calling.

## How to run

```bash
python tools/lookup.py <TICKER> [--mode manual|live] [--strike-pct 0.10] [--dte-min 14] [--dte-max 28]
```

Defaults come from `config.MODES["manual"]` (10% OTM, 14–28 DTE puts) unless `--mode live` is passed (5% OTM, 7–14 DTE).

## After running

1. Show the script's stdout to the user.
2. The script prints a `Chart: /tmp/lookup_<TICKER>_<TS>.png` line. **Read that PNG with the Read tool** so the chart renders inline. Don't summarize the chart — just display it.
3. Don't editorialize the wheelability score — the score's component breakdown speaks for itself.

## What NOT to do

- **Never place orders from this skill.** It's read-only by design.
- Don't suggest "you should buy/sell X" — the wheelability score evaluates *setup quality*, not price direction.
- Don't refetch the data with separate Alpaca calls; the script already does it efficiently in one pass.
