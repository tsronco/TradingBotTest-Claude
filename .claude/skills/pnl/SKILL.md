---
name: pnl
description: Portfolio P&L rollup across both paper accounts for a given period (day, week, month, 3m, year, all). Shows start/end equity, dollar delta, percent delta, peak, and trough — plus an equity-curve chart with both accounts overlaid. Read-only.
---

# /pnl [period]

Run `tools/pnl.py` with the period argument. After it prints `Chart: /tmp/pnl_<period>_<TS>.png`, **Read that PNG** so the chart renders inline.

## Argument parsing

- `/pnl` → today
- `/pnl day` / `/pnl today` / `/pnl 1d` → today
- `/pnl week` / `/pnl 1w` → past week
- `/pnl month` / `/pnl 1m` → past month
- `/pnl 3m` / `/pnl quarter` → past quarter
- `/pnl year` / `/pnl 1y` → past year
- `/pnl all` / `/pnl max` → since account inception

The script accepts these aliases natively; pass through whatever the user typed as the positional arg.

## How to run

```bash
python tools/pnl.py <PERIOD> [--no-chart]
```

## What NOT to do

- Don't extrapolate ("at this rate you'd make $X / year"). Past performance isn't a forecast and we don't have enough history yet.
- Don't compare to benchmarks (S&P, etc.) — that's not in scope here.
