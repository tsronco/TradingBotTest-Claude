# SM Put-Credit-Spread Engine — Hardening Design

**Date:** 2026-05-19
**Status:** Approved (design) — pending spec review
**Scope:** `config.py` (SM mode param blocks), `wheel_strategy.py` (`_auto_open_spread`, `handle_spread`), `screener_core.py` (curated universe). SM modes only — conservative/aggressive/manual/live byte-unaffected.

## Problem

The three small-account auto-spread paper accounts (`sm500`/`sm1000`/`sm2000`) are losing money on a structural basis, not from bad luck. Over the first two trading days (started 2026-05-18):

| Account | Start | Equity 2026-05-19 | P&L | Open-spread mark |
|---|---|---|---|---|
| sm500 | $500 | $451.51 | −$48.49 (−9.7%) | −$77.00 |
| sm1000 | $1,000 | $863.43 | −$136.57 (−13.7%) | −$71.00 |
| sm2000 | $2,000 | $1,904.58 | −$95.42 (−4.8%) | −$60.00 |
| **Total** | **$3,500** | **$3,219.52** | **−$280.48 (−8.0%)** | — |

Equity < cash on all three: the spreads still open are *also* underwater on the mark, on top of realized losses.

### Root cause: the win/loss size ratio, not the win rate

A put credit spread is a high-win-rate, small-edge instrument. The engine is likely winning *most* of its trades, but the payoff is fatally asymmetric. Observed fills:

| Spread | Credit collected | Cost to close | Realized P&L |
|---|---|---|---|
| sm2000 HPQ P19/P18 | ~$10 | −$64.04 | **−$64** |
| sm1000 NCLH P14/P13 | ~$15 | −$83.04 | **−$68** |
| sm2000 F P12/P11 | ~$10 | −$9.04 | +$0.92 (a "win") |
| sm500 F P12/P11 | ~$5 | −$6.04 | −$1.08 |

Expected-value illustration at an *85% win rate*:

| Scenario | Win rate | Avg win | Avg loss | EV / trade |
|---|---|---|---|---|
| Current engine | 85% | +$8 | −$80 | **−$5.20** |
| Tiny credit, tight stop | 75% | +$10 | −$25 | +$1.25 |
| Healthy credit, tight stop | 78% | +$33 | −$50 | **+$14.74** |

A high win rate cannot save a strategy whose wins are $8 and losses are $80. The fix is entry pricing and exit discipline, not instrument variety. Adding call credit spreads or iron condors was explicitly considered and rejected: same failure mode if credit is thin and the stop is loose, more moving parts, harder to validate on tiny accounts.

### Four structural faults (all in code today)

1. **No credit-to-risk floor.** `min_net_credit` is `$0.05/share` absolute — the engine will sell a $0.07 credit against a $0.93 max loss. There is no ratio gate.
2. **Width selection picks the stingiest spread.** `_auto_open_spread` chooses the *narrowest* width that clears the risk cap (`wheel_strategy.py:2531`). Narrowest width = smallest credit and least room — it actively selects the worst risk/reward.
3. **Stop is cycle-gated, not a real stop.** `handle_spread` closes at "loss ≥ 50% of max loss" priced off the executable close cost (`wheel_strategy.py:728`) — correct in principle, but only checked every 10 minutes. On illiquid cheap names a gap-down blows past the trigger to near-max-loss in one missed cycle. 50%-of-max-loss is also already a catastrophic loss relative to a thin credit.
4. **Universe forces junk.** The sm500 `max_underlying_price: 25` filter forces selection into the cheapest, gappiest, least-liquid names (NCLH, HPQ, KSS, RIVN, Macy's). No trend filter — selling puts into downtrends.

## Goals / Non-goals

**Goals:** Flip expectancy from reliably negative to reliably positive. Target a realistic 75–85% win rate *with positive expectancy* by fixing entry pricing, width selection, exit discipline, and universe quality.

**Non-goals (explicitly out of scope):**
- No new instrument types (no call credit spreads, no iron condors). Single hardened PCS engine.
- No delta-based strike selection — the credit-to-width floor enforces "paid enough" implicitly. Keep fixed % OTM.
- No auto-roll — a stopped-out spread closes, it does not roll (carried-forward decision from the original spread engine).
- Conservative/aggressive/manual/live modes unchanged and byte-unaffected (asserted by existing isolation tests).

## Design

### 1. Credit-to-width floor (keystone — new gate)

New config param `min_credit_to_width_pct`. A spread opens only if `net_credit ≥ width × min_credit_to_width_pct`.

- sm1000 / sm2000 (Balanced): `0.33` (≥ $0.33 on a $1-wide)
- sm500 (Conservative): `0.40` (≥ $0.40 on a $1-wide)

The existing `min_net_credit` absolute floor is retained only as a degenerate/negative-credit guard; the ratio gate becomes the real filter. Every losing trade in the screenshots fails this gate.

### 2. Width selection — best risk/reward, not narrowest

Change the long-leg search in `_auto_open_spread` from "first (narrowest) width that clears the risk cap" to "the width with the **highest credit-to-width ratio** among those that clear the risk cap and BP-fit." Same risk ceiling; stops auto-selecting the stingiest spread.

### 3. A stop that fires early enough to matter

The 10-minute cron cadence is a structural limit (no always-on process). Make the stop fire early enough that a one-cycle slip is survivable:

- **3a.** Change the stop trigger from "50% of max loss" to **"close when buy-back cost ≥ 2× the net credit received"** — a small, bounded dollar loss.
- **3b.** Add an **underlying-price tripwire** evaluated every cycle: if the stock trades through the short strike, close immediately. Robust when the option mid is degenerate/illiquid — exactly the case where today's stop fails.
- **3c. (Stretch — optional, must NOT block v1.)** Place a resting GTC stop on the short leg so Alpaca enforces it server-side between cycles. Feasibility of native stop orders on a short option leg is unknown; investigate, ship only if it pans out. v1 ships on 3a + 3b alone.

### 4. Quality + trend filter

- Replace the cheap-junk universe path with a **curated liquid list** in `screener_core.py` — tight option spreads and real IV (quality tier comparable to the conservative wheel), not "whatever is under $25."
- New **trend gate**: only open a put spread if the underlying is **above its 20-day SMA**.
- sm500 retains a price ceiling out of risk-cap necessity and is *expected to frequently no-trade* — correct behavior, logged as a normal no-trade event, not an error.

### 5. Risk-cap tightening + posture split

| Param | sm500 (Conservative) | sm1000 / sm2000 (Balanced) | Today |
|---|---|---|---|
| `min_credit_to_width_pct` | 0.40 | 0.33 | — (none) |
| `max_risk_pct_equity` | 0.10 | 0.10 | 0.20 / 0.15 |
| `max_concurrent_spreads` | 1 | 2 / 3 | 3 / 3 / 3 |
| stop trigger | 2× credit | 2× credit | 50% max loss |
| trend filter | on | on | off |

The 50%-profit winner exit (`spread_early_close_pct: 0.50`) is unchanged — it is the one piece working correctly.

### 6. Validation

No historical options data in-repo, so no backtest. Validation is forward-paper, consistent with how the spread engine was originally validated: ship hardened → observe ~2 weeks → measure **realized win rate, avg-win / avg-loss ratio, and net P&L**. The avg-win/avg-loss ratio is the primary success metric; win rate alone is explicitly not sufficient. Decide on scope changes (e.g., sm500 dormancy, widening the universe) only after that window.

## Testing

- New unit tests: credit-to-width gate accept/reject at boundary; best-ratio width selection vs the old narrowest selection; stop fires at 2× credit; underlying-price tripwire fires when stock crosses short strike; trend gate blocks below-SMA20 entries.
- Existing SM-isolation test must still assert conservative/aggressive/manual/live are byte-unaffected (no `min_credit_to_width_pct`, no trend gate, stop trigger unchanged for those modes).
- Mock all Alpaca + yfinance calls (existing `conftest.py` pattern).

## Risks / open questions

- Curated universe contents — needs a concrete name list during the implementation plan (criteria: liquid weeklies/monthlies, tight spreads, IV high enough that 10% OTM clears the 0.33 credit floor at reasonable DTE).
- 20-day SMA data source — reuse an existing price path or add a small cached helper; decide in the plan.
- Stretch 3c feasibility (Alpaca native stop on a short option leg) — investigate in the plan, do not block v1.
- sm500 may still effectively never trade under these gates. That is acceptable and expected; revisit only after the validation window.
