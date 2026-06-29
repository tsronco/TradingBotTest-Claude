---
name: screen
description: On-demand wheel-candidate screener — same logic as the Sunday cron, but stdout instead of Discord. Scores a universe of stocks by put-yield, spread tightness, and BP fit, returns the top N. Read-only.
---

# /screen [mode]

Run `tools/screen.py` and show the user the output verbatim.

## Argument parsing

- `/screen` → manual universe
- `/screen live` / `/screen agg` → live (high-IV) universe
- `/screen 5` → manual, top 5

Map mode words to positional `mode` arg (manual | live). Map a number to `--top N`.

## How to run

```bash
python tools/screen.py [manual|live] [--top N]
```

## What NOT to do

- Don't auto-suggest "you should add NVDA to the wheel" based on the screener — adding symbols requires a human decision (CLAUDE.md mentions priority-tier ordering for the live list specifically).
- Don't run the screener on every casual question — it makes a request per symbol in the universe (~50 API calls).
