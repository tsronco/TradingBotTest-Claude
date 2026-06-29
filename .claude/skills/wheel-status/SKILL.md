---
name: wheel-status
description: Per-symbol view of the wheel state in both paper accounts. Shows stage (1 CSP / 2 CC), open contract, days to expiration, entry premium, current premium, profit %, and progress toward the mode's early-close trigger. Read-only.
---

# /wheel-status

Run `tools/wheel_status.py` and show the user the output verbatim.

## Argument parsing

- `/wheel-status` → both modes, all symbols
- `/wheel-status TSLA` → both modes, only TSLA
- `/wheel-status manual` → manual only, all symbols
- `/wheel-status live TSLA` → live only, TSLA only

Map mode words (manual/live/cons/agg) to `--mode`. Pass any remaining ticker as the positional `symbol` arg.

## How to run

```bash
python tools/wheel_status.py [--mode MODE] [SYMBOL]
```

## What NOT to do

- Don't editorialize about whether to close a contract early. The tool already shows the % progress toward the early-close trigger; the user can decide.
- The wheel runs on cron — don't suggest the user run `wheel_strategy.py` manually based on this view.
