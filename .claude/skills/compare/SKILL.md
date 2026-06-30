---
name: compare
description: Ad-hoc side-by-side glance at the manual (paper $10k) and live (real money) accounts. Same numbers as the 4:12 PM ET daily summary, but on demand to stdout. Read-only.
---

# /compare

Run `tools/compare.py` and show the user the output verbatim.

## How to run

```bash
python tools/compare.py
```

No arguments. The script builds a per-account snapshot from `daily_summary._get_account`, `_summarize_wheel`, and `_summarize_long_options`.

## What NOT to do

- Don't declare a "winner" or suggest the user switch to the better-performing account — manual ($10k paper) and live (real money, separate capital base) are on completely different footings. The two columns are for a sanity check, not a race.
- Don't speculate about which account "should" be ahead — they run different operating models (live never auto-opens new puts or spreads).
