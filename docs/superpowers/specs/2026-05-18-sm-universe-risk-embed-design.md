# SM auto-spread: universe expansion + sm500 risk fix + spread embed cleanup

**Date:** 2026-05-18
**Status:** Design — approved, pending spec review
**Scope:** `screener_core.py`, `config.py`, `wheel_strategy.py`, related tests
**Affected accounts:** sm500, sm1000, sm2000 (paper). Conservative/aggressive/manual/live are byte-unaffected (no `auto_open_spreads`).

## Problem

The SM auto-spread engine went live 2026-05-18. After the `lxml` fix unblocked the earnings gate, sm2000 opened its first spread (SOFI). But:

1. **sm500 is structurally unable to trade.** It screens only ~8 names (the `max_underlying_price: 25` filter on a ~62-name list leaves few cheap names), and — more fundamentally — its risk budget cannot fit even the smallest constructible spread:
   - Budget = 15% × $500 = $75 max loss.
   - `round_strike` uses **$1 strike increments under $25**, so the narrowest spread it can build on a cheap underlying is **$1 wide**.
   - The risk gate uses gross `width × 100` = $100 > $75 → every sm500 candidate fails "no long leg fits risk budget", every cycle.
   - **Adding more candidates does not help** — they all hit the same wall. The blocker is the risk/width math, not candidate count.

2. **sm1000/sm2000 have a thin universe.** ~62 curated names is a small pool for a percentile-90→85 gate; more quality candidates = more chances to clear the full gauntlet.

3. **The "spread opened" Discord embed is unreadable.** Everything is crammed into one description blob with raw OCC symbols inline. The manual-mode **spread adoption** embed has the same problem.

## Non-goals

- Screening 300–500 symbols per account. Rejected during brainstorming: `score_candidate` is 3 sequential Alpaca calls/symbol; 500 symbols ≈ 1,500 calls/cycle every 10 min → rate-limit 429s (silently drops candidates), GitHub Actions step timeout risk, cron self-overlap. A moderate ~110-name universe (~330 calls, ~60–75s) is the safe ceiling.
- Per-account universe lists. Keeps the shared-core architecture; sm500 differentiation stays the price filter.
- Auto-roll, position-size guardrails, live-mode enablement — out of scope, unchanged.

## Part A — Universe expansion (`screener_core.py`)

Grow `DEFAULT_CONSERVATIVE_UNIVERSE` from ~62 to **~113** names. Selection bar unchanged: large/mid-cap, liquid options (tight spreads, real open interest), comfortable owning 100 shares at assignment, **no biotech lottery tickets / no penny names**. Deliberately load the **≤$25 tier** (~33 cheap names) so sm500's price-filtered subset becomes ~30+ instead of ~8.

Architecture unchanged: one shared list; sm500 keeps `max_underlying_price: 25`; sm1000/sm2000 screen the full list.

> **Price tags are approximate** (knowledge as of design date). The screener fetches the **live** price and applies `max_underlying_price` at runtime — so a mis-tagged name simply falls in/out of sm500's subset on a given day; it is never a correctness bug. The `≤$25` annotations below are guidance for list curation only.

### Proposed full list (~112)

**Existing 62 (unchanged):** AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, INTC*, ORCL, CRM, ADBE, IBM, CSCO, MU, AVGO, QCOM, TXN, AMAT, KLAC, LRCX, JPM, WFC, C, GS, AXP, V, MA, BAC*, MS, BLK, SCHW, CVX, COP, XOM, KMI*, OXY, PEP, WMT, COST, NKE, MCD, SBUX, HD, DIS, TGT, LOW, T*, VZ, JNJ, UNH, MRK, ABBV, PFE*, CVS, MDT, BMY, F*, GM, CAT, DE, HON, GE, UBER, LYFT, PLTR, SOFI*, NIO*, CCL*, AAL*, NOK*, SNAP*

**New — non-cheap quality adds (29):** PYPL, HPQ, DELL, MRVL, NXPI, MCHP, ADI, FTNT, PANW, CRWD, SHOP, ABNB, NFLX, USB, PNC, TFC, SLB, HAL, NEM, DOW, LYB, KO, PG, MDLZ, RTX, LMT, GILD, AMGN, ABT

**New — ≤$25 tier adds (22):** WBD*, PARA*, NCLH*, HOOD*, RIVN*, CLF*, VALE*, KGC*, GOLD*, AES*, KEY*, RF*, HBAN*, FITB*, ALLY*, SYF*, MOS*, SIRI*, KSS*, M*, HPE*, GRAB*

`*` = expected ≤$25 (sm500-eligible tier). Cheap tier after expansion ≈ 12 existing + 22 new ≈ **~34 names** → sm500 screens ~30+ instead of ~8.

Total = 62 + 29 + 22 = **113**. Final list subject to this spec review — strike/add names here.

API cost check: 113 × 3 calls ≈ 339 calls/cycle/account, ~60–75s score loop. Within the 10-min cron and GitHub Actions step budget (current 62 ≈ 30s). Earnings yfinance pass scales with the top ~15% of the eligible set (~17 names for sm1000/sm2000 vs ~9 now) — modest, `lxml` present.

## Part B — sm500 risk math (`config.py` + `wheel_strategy.py`)

### B1. Raise sm500 risk ceiling
`config.MODES`: `max_risk_pct_equity` for **sm500 only** `0.15 → 0.20`. sm1000/sm2000 stay `0.15`. Rationale: a $1-wide spread net of a typical credit ≈ $90 max loss; 20% × $500 = $100 gives it just enough headroom to ever trade. Accepted concentration: one sm500 position ≈ ~$90–100 at risk ≈ ~1/5 of the account. Deliberate, paper.

### B2. Risk gate → net-of-credit max loss
Today `spread_passes_risk(width, equity, max_risk_pct)` = `width*100 <= equity*max_risk_pct` (gross width). The true risk is `(width − net_credit) × 100` — which is **already the canonical `max_loss` convention** used by `_adopt_spread` and `_auto_open_spread` state seeding (`round(width - net_credit, 4)`). The gate using gross width was an inconsistency that overstates risk. Change the gate to evaluate net-of-credit max loss for **all SM modes** (more accurate everywhere; slightly loosens sm1000/sm2000, which is correct, not a regression).

**Implementation concern (for the plan, not decided here):** in `_auto_open_spread`'s width-search loop, the risk check at ~line 2167 currently runs **before** the long-leg quote is fetched (~2171) and before `net_credit` is computed (~2189, post-loop). Net-of-credit checking requires `net_credit` (= `short_mid − long_mid`) at check time. `short_mid` is known pre-loop; `long_mid` must be fetched **before** the risk check. The plan must reorder: fetch long quote → compute candidate `net_credit` → check `(width − net_credit)*100 ≤ equity*max_risk_pct`. Interaction with the existing `min_net_credit` floor (~2204) must be preserved (still reject sub-$0.05 credit; still `continue`, not `return`). `spread_passes_risk` signature changes (add `net_credit`, or accept a precomputed `max_loss`).

### B3. Test updates
- `tests/test_auto_spread.py`: `spread_passes_risk` tests updated for the new signature/semantics; add cases proving net-of-credit behavior (a width that fails gross but passes net, and vice-versa).
- `tests/test_modes_sm.py`: assert sm500 `max_risk_pct_equity == 0.20`; sm1000/sm2000 remain `== 0.15`.

## Part C — Discord spread embeds (`wheel_strategy.py`)

Reformat **both** the auto-spread *opened* embed (~line 2261) and the manual spread *adoption* embed to structured `send_embed(fields=[...])` instead of one description blob. `send_embed` already supports `fields: list[{"name","value","inline"}]`.

**Layout (approved):**

```
Title:        🎯 Put credit spread opened — SOFI
Description:  Screener-driven · wheelability 98
Fields (inline, 3 per row):
  Short put  | Long put  | Width
  $14.00     | $13.00    | $1.00
  Net credit | Max loss  | Expires
  $0.10/sh   | $0.91/sh  | 2026-06-05
  ($10.00)   | ($91.00)  | (18d)
Footer:       wheel_strategy.py · sm2000 · order 72028436…
```

Adoption embed: same field structure, title `📥 Spread adopted — {SYM}`, description noting it was a user-opened position now bot-managed. OCC symbols leave the headline (still in JSONL/Alpaca). DTE computed from expiration vs. today; order id truncated in footer.

**Isolation:** extract field-list construction into a small pure helper (e.g. `_spread_embed_fields(short, long, width, net_credit, max_loss, expiration) -> list[dict]`) so it is unit-testable without Discord I/O. Both call sites use it.

### Test updates
- New `tests/` case for `_spread_embed_fields`: correct labels, per-share + total $ math, DTE, field count/inline flags. (Discord transport itself stays mocked as today.)

## Validation plan

1. Unit: `python -m pytest tests/ -v` green, including new net-of-credit gate cases, universe-shape assertions (`len(DEFAULT_CONSERVATIVE_UNIVERSE) ≥ 110`, cheap-tier count ≥ ~30), sm500 risk == 0.20, embed-helper test.
2. Live (post-merge, next SM cycles): confirm sm500 `candidates_considered` jumps from 8 to ~30+; confirm an sm500 spread can open when a $1-wide net-of-credit fits 20%; confirm sm1000/sm2000 still trade and the new embed renders cleanly in `#sm{n}-trades`.
3. Watch `#sm*-errors` and run logs for Alpaca 429s or step-time growth from the larger universe (expected safe; verify).

## Risks

- **sm500 concentration:** ~20% of equity per trade. Accepted (paper, deliberate).
- **Net-of-credit gate loosens sm1000/sm2000 slightly.** Intended — aligns the gate with the existing `max_loss` convention; not a regression.
- **Universe quality drift:** the ≤$25 tier includes more volatile names (miners, airlines, beaten-down tech). Still within the existing "liquid options, would own" bar; final list gated by this spec review.
- **Runtime growth:** ~2× score-loop time. Measured-safe at ~110; do not grow unbounded later without re-checking the API budget.
```
