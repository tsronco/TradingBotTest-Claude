---
name: positions
description: Current holdings across both paper accounts (manual + live). Shows stocks and short/long options with quantity, avg cost, current price, market value, and unrealized P&L. Read-only.
---

# /positions

Run `tools/positions.py` and show the user the output verbatim.

## Argument parsing

- `/positions` → both accounts, all positions
- `/positions manual` or `/positions cons` → only manual
- `/positions live` or `/positions agg` → only live
- `/positions options` → only options across both
- `/positions stocks` → only stocks across both
- `/positions agg options` → live, options only

Map to flags: `--mode {manual|live|both}` and `--filter {stocks|options}`.

## How to run

```bash
python tools/positions.py [--mode MODE] [--filter KIND]
```

## What NOT to do

- Don't try to interpret what the user "should" do with these positions. Just display them.
- Don't refetch with separate Alpaca calls — the script does the fetching.
