---
name: compare
description: Ad-hoc head-to-head comparison between the manual and live paper accounts. Same numbers as the 4:12 PM ET daily summary's head-to-head embed, but on demand to stdout. Read-only.
---

# /compare

Run `tools/compare.py` and show the user the output verbatim.

## How to run

```bash
python tools/compare.py
```

No arguments. The script reuses `daily_summary._snapshot` for both modes.

## What NOT to do

- Don't recommend "switch to the winning mode" — they run side-by-side intentionally for the A/B test, not as a horse race to pick from.
- Don't speculate about the lead being permanent — early data, small differences.
