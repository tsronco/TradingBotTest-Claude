---
name: health
description: Sanity check on the bot's plumbing — Alpaca creds authenticate for both accounts, state files parse and were checked recently, no stale open orders. Read-only. Run this when something feels off.
---

# /health

Run `tools/health.py` and show the user the output verbatim.

## How to run

```bash
python tools/health.py
```

No arguments. Each line gets a green check, yellow flag, or red X.

## What NOT to do

- Don't try to fix issues automatically. If a check fails, surface it; let the user decide what to do.
- Don't run other diagnostic commands unless the user asks. The script does the full health pass already.
