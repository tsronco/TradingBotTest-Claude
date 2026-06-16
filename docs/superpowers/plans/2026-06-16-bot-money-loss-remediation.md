# Bot money-loss remediation plan (2026-06-16)

## Purpose

Two manual-account put credit spreads (MU, QQQ) closed for a few-hundred-dollar
loss each on intraday noise this week. That triggered a broader question: what
*else* in the bot quietly throws money away? Two independent adversarial code
reviews were run with fresh eyes (Opus 4.8 and Sonnet 4.6, each with no
knowledge of how the code was written) on the whole Python bot, briefed to find
every way it loses money with real capital.

This document is the reconciled, deduplicated catalog of their findings plus a
priority-ordered remediation roadmap. We work it **one finding at a time, in
order**, each with its own verification + test + commit, so we don't skip
something that matters later or burn effort on a symptom instead of the cause.

## Scope and stance

- **The `manual` account is our active book today.** It is the account we are
  actually trading. Its correctness matters as much as live-readiness — a bug
  that bleeds manual is bleeding us *now*, on paper, and would bleed live later.
- **The `live` account is not on yet**, but it runs the *same scripts*. Anything
  that bites the code paths `live` will run must be correct before we flip it on.
- Therefore the ordering below is by **how many of the accounts-we-care-about
  (manual + live) actually execute the buggy path**, then by dollar severity.
- Every finding is re-confirmed against the live code at fix time before we
  change anything — the reviews are a map, not gospel. Self-retracted
  "not-a-bug" items from the reviews are listed at the end so we don't
  re-litigate them.

## Which modes run which code (prioritization key)

This is the crux of triage. A bug only matters to an account if that account
executes the path.

| Code path | cons/agg | manual (ACTIVE) | live (off) | sm500/1000/2000 |
|---|---|---|---|---|
| Shared Alpaca HTTP layer (`api_post` → `_alpaca_request`) | ✅ | ✅ | ✅ | ✅ |
| `strategy.py` trail / ladder / stop on held stocks | ✅ (TSLA) | ✅ (auto-discover) | ✅ (auto-discover) | ✅ |
| Wheel 50%-close on existing short puts/CCs | ✅ | ✅ | ✅ | ✅ |
| Wheel opens NEW Stage-1 puts (`_sell_new_put`) | ✅ | ❌ skip_new_puts | ❌ skip_new_puts | ❌ skip_new_puts |
| `long_options_strategy` exits | ✅ | ✅ | ✅ | ✅ |
| Spread *management* (`handle_spread`, close paths, tripwire) | ❌ | ✅ adopted/hand-opened | ❌ until enabled | ✅ |
| Spread *auto-open* (`_auto_open_spread`, screener) | ❌ | ❌ disabled 2026-06-03 (PDT) | ❌ | ✅ |

Takeaways:
- The **shared HTTP layer** bug (R1) hits *every* account, including live's
  manage-only closes. Highest blast radius. Fix first.
- **`strategy.py` and `long_options` and wheel-close** bugs hit manual AND live
  directly (both manage held positions). Tier 1.
- **Spread management** bugs hit manual (it manages adopted spreads) and SM, and
  will hit live only when `spread_management` is flipped on. Tier 2.
- **Spread auto-open** bugs hit SM today (and manual only if we re-enable
  `auto_open_spreads`, which is currently off for PDT reasons). Tier 2b.

## Working agreement (how we execute this plan)

1. Take findings strictly in the order below unless a dependency forces a swap.
2. For each: (a) re-read the code and confirm the bug is real and as described;
   (b) write/extend a failing test that captures it; (c) implement the fix;
   (d) run the full bot suite; (e) commit with a message referencing the finding
   ID; (f) update this file's status table and the `CHANGELOG`.
3. One finding per commit where practical, so each is independently revertible.
4. Re-confirm mode-applicability at fix time — make non-spread / non-active modes
   byte-unaffected unless the fix is a shared-layer correctness fix that should
   apply everywhere (e.g. R1).
5. After each fix, report back before starting the next.

---

## Priority roadmap

### PHASE 1 — Tier 1: bites manual (active) and/or live right now

| ID | Severity | Modes affected | Title |
|---|---|---|---|
| R1 | 🔴 Critical | ALL (incl. live) | Non-idempotent POST retry can double-place orders (no `client_order_id`) |
| R32 | 🔴 Critical | manual, live | `long_options` hedge guard is PUT-only → call-credit long call gets stop-lossed → **naked short call (unlimited risk)** |
| R33 | 🟠 High | live | `apply_mode("live")` silently falls back to the PAPER endpoint on missing/bad `ALPACA_LIVE_BASE_URL` → live account unmanaged |
| R2 | 🟠 High | cons/agg, manual, live | Average-down drift reconciliation doesn't reset HWM/trailing → spurious stop |
| R3 | 🟠 High | cons/agg, manual, live | `long_options` exits priced/decided off stale last-trade price |
| R4 | 🟠 High | ALL wheel (double-open: cons/agg only) | Wheel 50%-close priced off stale last-trade → unfilled close + state/reality drift |
| R31 | 🔴 Critical | cons/agg | `close_all(SYMBOL)` liquidates CC-collateral shares → **naked short call (unlimited risk)** |

### PHASE 2 — Tier 2: spread management (manual adopted spreads + SM; live when enabled)

| ID | Severity | Modes affected | Title |
|---|---|---|---|
| R5 | 🟠 High | manual, SM | `_close_spread_mleg` market order → fills far worse than stop on illiquid chains |
| R6 | 🟠 High | manual, SM | Leg-by-leg fallback close prices at MID → won't fill → orphaned/naked legs |
| R7 | 🟠 High | manual, SM | `_close_spread_mleg` returns success on HTTP-200 without verifying fill → state deleted, positions live |
| R8 | 🟡 Medium | manual, SM | Tripwire pending-return also skips DTE-floor close (gap in the 2026-06-16 tripwire fix) |
| R9 | 🟡 Medium | manual, SM | DTE-floor `get_latest_price` not wrapped in try/except → network error skips the close |
| R10 | 🟡 Medium | manual, SM | `net_credit = None` in spread state → `handle_spread` crashes, spread unmanaged |
| R11 | 🟡 Medium | manual, SM | Adopted-spread `net_credit` trusts Alpaca per-leg `avg_entry_price` (can be wrong for mleg fills) |

### PHASE 2b — Tier 2b: spread auto-open (SM now; manual only if re-enabled)

| ID | Severity | Modes affected | Title |
|---|---|---|---|
| R12 | 🟡 Medium | SM | `normalize_scores` with small pool (n=2) → 0/100 → wheelability gate meaningless |
| R13 | 🟡 Medium | SM | Alpaca null order id → `open_order_id=None` → orphan handler fires → reopen loop |
| R14 | 🟡 Medium | SM (manual if re-enabled) | Multi-open cycle reuses stale buying power across opens |
| R15 | 🟡 Medium | SM | `get_option_quote` rejects zero-bid long legs → valid cheap spreads skipped |
| R16 | 🟡 Med/Low | SM auto-open; cons/agg CSP | Earnings: same-day-past not blocked; cons/agg `_sell_new_put` has NO earnings check |

### PHASE 3 — Tier 3: correctness / robustness / hygiene

| ID | Severity | Modes affected | Title |
|---|---|---|---|
| R17 | 🟡 Medium | ALL wheel | `get_option_last_price` fallback divides `market_value` by 100, not 100×qty (multi-contract mispricing) |
| R18 | 🟡 Medium | manual, live | Stage-2 "called away" detection (`<100 shares`) misfires on non-100-lot manual holdings |
| R19 | 🟡 Medium | manual, live | `place_buy_to_close(qty=None)` closes the FULL position → can close a user's overlapping hand-sold contract |
| R20 | 🟡 Medium | manual, live | `_available_qty` seed vs. drift reconcile after a CC closes → ladder qty off |
| R21 | 🟢 Low | manual, live | `_discover_wheel_state` single-leg adoption can overwrite richer in-flight state |
| R22 | 🟢 Low | manual, SM | Adopted spreads inherit the 20-min settle window (loss-stop suppressed) |
| R23 | 🟢 Low | manual, SM, live | `_discover_wheel_state` runs before the `is_market_open()` check (off-hours API calls/embeds) |
| R24 | 🟢 Low | cons/agg | STO limit at mid on illiquid chains → BP tied up in unfilled orders |
| R25 | 🟢 Low | ALL wheel | `cycle_count` not incremented on the CC-expired path (reporting off-by-one) |
| R26 | 🟢 Low | cons/agg (latent) | `strategy.run_one_cycle` hardcodes `SYMBOL="TSLA"` |
| R27 | 🟢 Low | cons/agg (edge) | `entry_price` `KeyError` if a state file is incompletely seeded |
| R28 | 🟢 Low | ALL wheel CC | `round_strike` uses cost basis (not spot) as the increment reference → off-grid strike |
| R29 | 🟢 Low | manual, SM | Duplicate adoption embeds if `save_state` fails after an adoption |
| R30 | 🟢 Low | SM | Width-loop early-break assumes monotone net_credit (theoretical) |

---

## Finding detail

Each entry: **location → scenario → why it costs money → fix direction → test
direction → status.** Source tags reference the original reviewer findings
(O# = Opus, S# = Sonnet) for traceability.

### R1 — Non-idempotent POST retry can double-place orders 🔴 Critical  [O1; corroborated by S3, S24]
- **Status:** ✅ DONE (2026-06-16). `client_order_id` stamped on every POST
  /orders in `wheel_strategy.api_post` (covers `long_options` via import) and
  `strategy.place_order`; duplicate-id 422 on a retry resolves to the existing
  order via `/orders:by_client_order_id`. +6 tests (`test_order_idempotency.py`).
  Applies to ALL modes (shared-layer correctness fix), incl. live.
- **Location:** `wheel_strategy.py:1049-1094` (`_alpaca_request`, `api_post`),
  the analogous request layer in `strategy.py`, and any order POST in
  `long_options_strategy.py` / `congress-copy`. No `client_order_id` exists
  anywhere (grep: 0 hits).
- **Scenario:** Bot POSTs `/orders`. Alpaca *creates* the order but the response
  is lost — gateway 502/504 (in `_ALPACA_RETRY_STATUS`) or a dropped
  `ConnectionError`/`Timeout`. `_alpaca_request` re-issues the identical POST.
  Two orders now exist; Alpaca cannot dedupe without a client id.
- **Cost:** Doubled short puts (double assignment/collateral — the "MARA qty=−4"
  class of incident), doubled buy-to-closes (can flip to long), doubled ladder
  buys. Lives in the shared HTTP layer, so it **bypasses all mode-gating** and
  can hit the live real-money account even in manage-only posture.
- **Fix direction:** Stamp a deterministic `client_order_id` on every POST
  `/orders` across all order-placing scripts (e.g. hash of
  mode+symbol+side+strike+expiry+intent+cycle-bucket); Alpaca rejects a
  duplicate id, making retries safe. Alternatively/additionally: do not retry
  POST `/orders` at the transport layer — on a POST timeout, query open+recent
  orders before re-placing. Prefer the client-order-id approach (robust to both
  retry and cross-cycle dup).
- **Test direction:** Unit-test that a retried POST carries a stable
  `client_order_id`; simulate a 502-then-200 and assert only one logical order
  intent; simulate a duplicate-id rejection is handled gracefully.

### R2 — Average-down reconciliation doesn't reset HWM/trailing 🟠 High  [S30]
- **Status:** ✅ DONE (2026-06-16). `_manual_run_symbol`'s drift block now
  re-baselines the trail (HWM + entry → new avg, `trailing_active` → False) when
  the avg cost DROPS (average-down), so the trailing stop can't snap above the
  new cost basis. An average-up keeps its ratcheted trail. +3 tests
  (`test_manual_drift_trailing.py`). Affects manual + live + SM.
- **Location:** `strategy.py:636-641` (drift block resets qty/avg/total/stop but
  not `high_water_mark`/`trailing_active`); trailing block `strategy.py:708-712`
  only ever *raises* the stop.
- **Scenario:** You hold N shares; you manually buy more at a lower price
  (average down). Drift reconcile sets `stop = new_avg × 0.90`. But the stale
  `trailing_active=True` + old high `high_water_mark` cause the trailing block to
  recompute `HWM × 0.95` and *raise* the stop back above your new cost basis.
  Any small further dip fires the stop and liquidates the position you just
  added to.
- **Cost:** Forced liquidation of an intentionally-averaged-down position. Hits
  manual (active) and live (both auto-discover and trail/ladder/stop held names).
- **Fix direction:** On a drift that *lowers* avg cost (or any qty/avg change),
  re-baseline the trailing state: reset `high_water_mark` to the new avg cost (or
  current price) and reconsider `trailing_active`. Decide explicit semantics: a
  manual average-down should not inherit a pre-existing trailing ratchet.
- **Test direction:** Seed a trailing-active position with a high HWM, simulate
  an average-down drift, assert the stop is not raised above the new cost basis.

### R3 — `long_options` exits decided off stale last-trade price 🟠 High  [S25; theme shared with O4]
- **Status:** ✅ DONE (2026-06-16). New `_current_mark` prefers the live two-
  sided quote MID over the last trade for `evaluate_position`'s stop/take-profit
  decision, falling back to last trade only when no quote exists. +5 tests
  (`test_long_options_stale_price.py`). (Zero-bid stale case still tracked under
  R15.) Affects cons/agg + manual + live.
- **Location:** `long_options_strategy.py` ~line 340 (`get_option_last_price`
  drives `pnl_pct` → take-profit/stop-loss).
- **Scenario:** Illiquid long option; last *trade* is stale (hours/days old). The
  underlying moves but `current` reflects the old print → `pnl_pct` is wrong. A
  long put worth near zero shows a small loss (stop never fires → ride to zero);
  a long call shows a phantom +100% (premature take-profit on a still-running
  winner).
- **Cost:** Missed stops / premature profit-takes on long options. Runs on manual
  + live + cons/agg.
- **Fix direction:** Decide exits off the live quote mid (`get_option_quote`),
  not last trade; price *urgent* closes marketable (consistent with the
  2026-05-30 spread fix). Guard against missing/degenerate quotes (skip cycle,
  don't act on noise).
- **Test direction:** Stale last-trade vs. fresh-quote divergence → assert the
  decision uses the quote and the close is marketable.

### R4 — Wheel 50%-close priced off stale last-trade 🟠 High  [O4, S2, S3]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py` ~2056-2063 (Stage 1), ~2350-2357 (Stage 2);
  `place_buy_to_close` adds only +$0.05 to a last-trade-derived limit.
- **Scenario:** Stale last-trade triggers the 50%-profit check and places a BTC
  limit below the real ask → rests unfilled. State + Discord announce "closed at
  50% profit" while the position is still open (state/reality divergence). On
  cons/agg only, the code then clears state and calls `_sell_new_put` in the same
  cycle → a second short can be opened before the BTC fills → **doubled short**.
  (manual/live are protected from the double-open by `wheel_skip_new_puts`, but
  still suffer the unfilled-close + false-state divergence.)
- **Cost:** False "closed" state + unfilled exit (all wheel modes incl.
  manual/live); doubled short exposure (cons/agg).
- **Fix direction:** Price the BTC marketable off `get_option_quote` ask; do not
  clear `current_contract`/open a replacement until the close is confirmed filled
  (resolve via order status next cycle, mirroring the pending-resolution pattern
  used elsewhere).
- **Test direction:** Stale-last vs quote; assert marketable BTC and that state
  is not cleared (and no reopen) until fill is confirmed.

### R5 — `_close_spread_mleg` market order fills badly 🟠 High  [O3, S4]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:370-379` (`"type": "market"`).
- **Scenario:** Primary spread close is a *market* mleg. On an illiquid spread,
  it fills at short-ask − long-bid (full width crossed). A "50% profit" or "2×
  credit stop" computed on mids can realize materially worse at the market fill —
  asymmetric with the careful near-mid *entry* logic.
- **Cost:** Premium given back on exit; a paper win can realize as a loss. Manual
  (adopted spreads) + SM.
- **Fix direction:** Use a *marketable limit* mleg (limit at the executable
  cross, bounded) instead of a pure market order, so a degenerate quote can't
  fill arbitrarily badly while still filling.
- **Test direction:** Wide-chain quote → assert the close limit is bounded at the
  executable cross, not unbounded market.

### R6 — Leg-by-leg fallback close prices at MID 🟠 High  [O2, S5]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:410-421` (`_mid_or_entry`), the mleg-rejection
  fallback path.
- **Scenario:** Alpaca rejects the mleg close (known NVDA/MU 403s); fallback
  closes legs individually at mid+$0.05. On the wide/dying chains stops hit, that
  rests below the ask → short BTC doesn't fill (stays open, ITM), or short fills
  but long STC (also mid) doesn't → **naked short** until next cycle's orphan
  handler.
- **Cost:** Stuck/again-firing close on the primary stop path; transient naked
  short (assignment risk). Manual + SM.
- **Fix direction:** Make the fallback marketable like `_handle_orphan_leg`
  already is — pay the ask to BTC the short, hit the bid to STC the long. The
  short especially must fill.
- **Test direction:** mleg-reject → assert both fallback legs price marketable.

### R7 — mleg close returns success without verifying fill 🟠 High  [S20]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:356-384` (returns True if `api_post` didn't
  raise), caller `_close_spread` deletes state on True.
- **Scenario:** Alpaca returns HTTP 200 but the mleg is `rejected`/`canceled`/
  `partially_filled` (wash-trade rules, market conditions, one leg fills). Bot
  reads True → deletes state → positions still open but now untracked (re-adopted
  fresh on manual/SM losing history; orphaned on cons/agg).
- **Cost:** Lost spread tracking; unmanaged positions. Manual + SM.
- **Fix direction:** Confirm terminal fill status before declaring success and
  deleting state (poll order/legs; treat partial/rejected distinctly — keep state
  / route to orphan handling). Tie into the R1 verification machinery.
- **Test direction:** 200-but-rejected and 200-but-partial responses → assert
  state is NOT deleted and the survivor is handled.

### R8 — Tripwire pending-return blocks ALL other spread triggers 🟠 High (upgraded)  [O6, S(v2)3 — gap in our 2026-06-16 fix]
- **Status:** NOT STARTED. **Severity upgraded from Medium → High** after the
  v2 review: the pending-`return` skips the **profit trigger, the loss-stop, AND
  the DTE-floor** — not just the DTE-floor.
- **Location:** `wheel_strategy.py` tripwire pending branch (the `return` that
  short-circuits the rest of `handle_spread` while a breach is unconfirmed).
- **Scenario A (lost profit):** A spread sits at 48% profit; the stock wicks
  fractionally below the short strike (recovers in 20 min). The tripwire arms and
  the pending-`return` suppresses the **profit close** for up to 60 min. The
  spread can reverse from a near-win back to a stopped-out loss while we're
  blocked from taking the 50%.
- **Scenario B (delayed stop / assignment):** Manual, DTE ≤ 2, stock oscillates
  across the strike. The 60-min clock keeps resetting and never confirms; the
  pending-`return` skips the DTE-floor close every cycle → spread rides to
  expiration ITM → short-leg assignment (100×strike BP on a small account).
- **Cost:** Forfeited profit on a winner; missed loss-stop / DTE-floor →
  assignment. Manual + SM.
- **Fix direction:** Narrow what the confirmation window suppresses. While
  pending, still run the **profit trigger** and the **DTE-floor** close (both are
  legitimate "get out" signals). Defer ONLY the loss-stop (the one most prone to
  noise) — and the tripwire's own close, which is what the confirmation governs.
- **Test direction:** (a) Pending breach + ≥50% profit → assert profit close
  still fires; (b) 2-DTE ITM oscillating breach → assert DTE-floor close fires
  while pending; (c) pending breach + mid-loss past stop → assert loss-stop is
  (intentionally) deferred.

### R9 — DTE-floor `get_latest_price` not guarded 🟡 Medium  [S11]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py` DTE-floor block (~980-991) calls
  `get_latest_price` without try/except, unlike the tripwire path.
- **Scenario:** Network hiccup near expiry → exception aborts `handle_spread` for
  that symbol → the DTE-floor close (ITM short, ≤2 DTE) is skipped → possible
  assignment.
- **Fix direction:** Wrap in try/except like the tripwire; on failure, skip the
  cycle gracefully (don't crash the symbol).
- **Test direction:** `get_latest_price` raises → assert symbol cycle survives.

### R10 — `net_credit = None` crashes `handle_spread` 🟡 Medium  [S12]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py` `_compute_spread_pnl` / `handle_spread`
  (`float(sym_state["net_credit"])` with no None guard).
- **Scenario:** Corrupted/half-written state has `net_credit=None` → TypeError →
  spread goes unmanaged.
- **Fix direction:** Guard None/invalid `net_credit` (skip-with-warning or
  reconcile from legs); ensure seeding never leaves it None.
- **Test direction:** None `net_credit` → assert graceful skip, no crash.

### R11 — Adopted-spread `net_credit` trusts per-leg `avg_entry_price` 🟡 Medium  [S17]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~2526, 2565` (`_detect_spread_pairs`).
- **Scenario:** For an mleg-opened spread, Alpaca's per-leg `avg_entry_price` may
  not split cleanly → `net_credit = short_entry − long_entry` wrong at adoption →
  all P&L / stop triggers off from the start.
- **Fix direction:** Sanity-check the derived `net_credit` (sign/magnitude vs.
  width); where possible reconcile from the opening order legs; reject obviously
  wrong values rather than seeding them.
- **Test direction:** Skewed per-leg entries → assert `net_credit` is validated.

### R12 — `normalize_scores` gate meaningless for small pools 🟡 Medium  [S14]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~2776-2787` (`i/(n-1)*100`).
- **Scenario:** When only 2 candidates survive filters, scores are forced to 0
  and 100; the `wheelability_min` (75-80) is auto-cleared by the "winner"
  regardless of absolute quality → can open a junk spread.
- **Fix direction:** Gate on an *absolute* quality floor too (raw score / credit-
  to-width / etc.), or require a minimum pool size before percentile-ranking
  carries weight; don't let a 2-name pool auto-pass.
- **Test direction:** 2-name pool with poor raw scores → assert no open.

### R13 — Null order id → reopen loop 🟡 Medium  [S24]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~3332-3347` (`open_order_id = id if != "?" else None`).
- **Scenario:** Alpaca returns `{"id": null}` → `open_order_id=None` → next cycle
  `handle_spread` skips pending-resolution → orphan handler sees both legs absent
  (order still pending) → deletes state → opener re-opens → loop (and possible
  multiple orders — ties into R1).
- **Fix direction:** Treat a missing/None order id after a POST as "unknown,
  must reconcile" — query recent orders for the just-placed legs before seeding /
  before any re-open; never let a pending open masquerade as an orphan.
- **Test direction:** Null-id open response → assert no reopen, state reconciles.

### R14 — Multi-open cycle reuses stale buying power 🟡 Medium  [O5, S13]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~3005-3006` (BP read once), risk checks reuse
  it across opens; `_auto_open_spread` equity is fresh but `options_bp` is stale.
- **Scenario:** `max_opens_per_cycle > 1` (manual was 2 before auto-open was
  disabled; SM caps vary): the 2nd open's `bp_fits` uses pre-1st-open BP → can
  pass a check it shouldn't → 403 (recoverable today, but the guard isn't real).
- **Fix direction:** Re-fetch account/BP after each open, or decrement the local
  BP estimate by the just-opened spread's collateral (mirror the `_sell_new_put`
  local-decrement pattern).
- **Test direction:** Two opens in one cycle → assert BP gate sees the first
  open's consumption.

### R15 — Zero-bid long legs skipped 🟡 Medium  [S34]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~1585-1590` (`get_option_quote` returns None if
  bid OR ask is 0).
- **Scenario:** A far-OTM long leg legitimately has bid $0.00 / ask $0.05 →
  treated as unquotable → that width skipped → sm500 cheap-underlying spreads
  often find no eligible width → false no-trade.
- **Fix direction:** Allow a zero *bid* with a positive ask for the long leg when
  pricing a spread (the long is something we BUY — the ask matters), while still
  guarding genuinely absent quotes. Be careful to keep the short-leg quote
  validity strict.
- **Test direction:** Zero-bid/positive-ask long → assert the width is considered.

### R16 — Earnings gaps 🟡 Med/Low  [O7, S7]
- **Status:** NOT STARTED.
- **Location:** `earnings.py:44-45` (`0 <= delta <= days*86400`, same-day-past
  returns not-blocked); `_sell_new_put` (cons/agg CSP) has **no** earnings check.
- **Scenario:** (a) An earnings timestamp a few hours past (yfinance midnight-
  dating imprecision) reads as not-blocked → could open into a post-earnings
  session. (b) cons/agg can sell a CSP straight into earnings (no gate at all).
- **Fix direction:** Tighten the earnings window's lower bound / treat same-
  session earnings as blocked; consider adding an earnings gate to the cons/agg
  CSP path (separate decision — confirm desired with Tim). Live is safe via
  `wheel_skip_new_puts`. **Also (v2 #9):** the fail-closed earnings cache is
  per-process — under yfinance rate-limiting (3 SM accounts × ~52 symbols on
  shared GH Actions egress) it can return "unknown → blocked" for the whole
  universe and zero out SM opens for days. Persist the earnings cache to a small
  committed JSON with a 6–24h TTL so runners reuse recent results and survive
  transient yfinance outages.
- **Test direction:** Same-day earnings → assert blocked; cons/agg CSP into
  earnings → assert gated (if we add the gate).

### R17 — Multi-contract `market_value/100` mispricing 🟡 Medium  [S1]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~1905-1907` (`get_option_last_price` fallback:
  `abs(market_value)/100`).
- **Scenario:** Position with qty>1 (e.g. the MARA quad). `market_value` is the
  combined value; ÷100 (not ÷(100×qty)) returns a price N× too high → 50%-close
  check never satisfied → winner held too long.
- **Fix direction:** Divide by `100 × abs(qty)`.
- **Test direction:** qty=4 position → assert per-contract price.

### R18 — Stage-2 "called away" misdetect on non-100 lots 🟡 Medium  [S27, S(v2)10 — corroborated by both Sonnet passes]
- **Status:** NOT STARTED. Note: a partial *manual sell* (e.g. 200→50 shares)
  also trips this and additionally leaves a partially-naked CC. Fix should detect
  a genuine assignment (qty → 0 / symbol gone), not an absolute `<100`, and
  alert+halt the symbol on an ambiguous 1–99 remainder rather than guessing.
- **Location:** `wheel_strategy.py:~2266` (`qty < 100` ⇒ "called away").
- **Scenario:** Manual holds a non-100-lot (e.g. 50 shares) adopted into Stage 2.
  CC expires; 50 shares remain; `qty < 100` reads as "called away" → resets to
  Stage 1, fires a false "CALL ASSIGNED" embed, loses track of the 50 shares.
- **Fix direction:** Detect assignment by an actual *decrease* in share count
  vs. tracked qty (or qty crossing below the covered amount), not an absolute
  `<100`.
- **Test direction:** 50-share Stage-2, CC expires, 50 remain → assert no false
  assignment.

### R19 — `place_buy_to_close(qty=None)` closes the full position 🟡 Medium  [S32]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~1484-1490`.
- **Scenario:** Wheel-managed short put on an OCC where the user *also* hand-sold
  one (position qty −2). `qty=None` closes the actual position size (2) though the
  wheel tracked 1 → collapses the user's manual contract; next cycle the wheel
  sees the position gone and may sell a new put.
- **Fix direction:** Close exactly the bot-tracked `contract_qty`, not the full
  Alpaca position, when state knows how many it owns. (Balance against the
  historical "qty=−N duplicate" cleanup intent — reconcile with R1.)
- **Test direction:** OCC with mixed bot+user qty → assert only the tracked qty
  closes.

### R20 — `_available_qty` seed vs. reconcile after CC closes 🟡 Medium  [S7]
- **Status:** NOT STARTED.
- **Location:** `strategy.py:~603-641`.
- **Scenario:** SNAP 110 shares, 100 locked under a CC → seed records free qty 10
  and `initial_qty=10`. After the CC closes, `qty_available` jumps to 110 → drift
  reconcile resets `position_qty=110` but ladder multipliers still key off
  `initial_qty=10` → ladder sizes wrong for the real position.
- **Fix direction:** Define intended semantics for collateral-locked shares;
  re-baseline `initial_qty` on a large upward reconcile, or track managed vs.
  total explicitly.
- **Test direction:** Seed at 10 free, reconcile to 110 → assert ladder scaling
  is sane.

### R21 — Single-leg adoption overwrites richer state 🟢 Low  [O8]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~2724-2738` (`_discover_wheel_state`).
- **Scenario:** A discovered short whose OCC ≠ tracked `current_contract`
  overwrites contract fields; if the symbol had in-flight state for a different
  contract, it's clobbered. Rare, but live positions are user-driven and less
  predictable.
- **Fix direction:** Guard against overwriting a populated, still-valid contract;
  reconcile rather than clobber.
- **Test direction:** Two contracts same underlying → assert no clobber.

### R22 — Adopted spreads inherit the settle window 🟢 Low  [S10]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:2621` (`_adopt_spread` sets `opened_at`) →
  `_within_settling_window` suppresses the loss-stop for 20 min post-adoption.
- **Scenario:** A hand-opened spread adopted at 9:35 has its loss-stop suppressed
  until 9:55 (tripwire still works). Undocumented for *adopted* (vs freshly
  bot-opened) spreads.
- **Fix direction:** Only apply the settle window to bot-*opened* spreads (those
  with an `open_order_id`), not adopted ones — or set `opened_at` to the true
  position open time at adoption. Confirm desired behavior with Tim.
- **Test direction:** Adopted spread → assert loss-stop not suppressed (or
  document the intended suppression).

### R23 — Discovery before market-open check 🟢 Low  [S8]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~3404-3442`.
- **Scenario:** `_discover_wheel_state` makes API calls / can fire adoption
  embeds before `is_market_open()`. Mostly waste + off-hours embeds; inconsistent
  guard placement.
- **Fix direction:** Move the market-open guard earlier (or make discovery
  side-effect-free when closed). Keep the auto-open's own market check.
- **Test direction:** Market-closed → assert no adoption embeds / minimal calls.

### R24 — STO mid won't fill on illiquid chains 🟢 Low  [S9]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~1594-1609` (`compute_limit_price` returns mid).
- **Scenario:** Wide bid/ask → STO rests at mid, unfilled up to
  `STALE_AFTER_HOURS`, tying up BP. cons/agg (the modes that open new puts).
- **Fix direction:** Consider a slightly-into-the-spread STO price for illiquid
  chains; balance fill rate vs. premium captured. Low urgency.
- **Test direction:** Wide chain → assert STO price is fillable per policy.

### R25 — `cycle_count` off-by-one on CC-expired path 🟢 Low  [S16]
- **Status:** NOT STARTED. Reporting only.
- **Location:** `wheel_strategy.py:~2313-2339` (CC-expired path doesn't increment
  `cycle_count`, unlike the put-expired path).
- **Fix direction:** Increment consistently. **Test:** CC expiry → count +1.

### R26 — `SYMBOL="TSLA"` hardcoded in `run_one_cycle` 🟢 Low (latent)  [S6]
- **Status:** NOT STARTED.
- **Location:** `strategy.py:29, 434, 446`.
- **Scenario:** cons/agg non-manual cycle always monitors/`close_all` TSLA.
  Harmless today (both seed TSLA) but a latent correctness gap if diversified.
- **Fix direction:** Parameterize the symbol; or document the constraint
  explicitly. **Test:** non-TSLA state → assert correct symbol used.

### R27 — `entry_price` KeyError on incomplete state 🟢 Low (edge)  [S23]
- **Status:** NOT STARTED.
- **Location:** `strategy.py:~424`.
- **Fix direction:** `.get` with a sane default / explicit re-seed. **Test:**
  missing key → assert no crash.

### R28 — `round_strike` reference is cost basis, not spot 🟢 Low  [S29]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~2410-2412`.
- **Scenario:** CC strike increment chosen off cost basis can land off-grid vs.
  the actual chain when spot has moved across the $25 increment boundary;
  `find_best_contract` then picks the nearest real strike (not dangerous, just
  suboptimal).
- **Fix direction:** Use spot (or the chain's actual strikes) for the increment
  decision. **Test:** cost basis < $25, spot > $25 → assert on-grid target.

### R29 — Duplicate adoption embeds if `save_state` fails 🟢 Low  [S35]
- **Status:** NOT STARTED.
- **Location:** `_adopt_spread` / `_discover_wheel_state` fire embeds before the
  end-of-cycle `save_state`.
- **Scenario:** `save_state` fails after an adoption embed → next cycle re-adopts
  and re-embeds. Annoyance, not loss.
- **Fix direction:** Make adoption idempotent against unsaved state, or persist
  immediately on adoption. **Test:** save failure → assert no duplicate embed.

### R30 — Width-loop early-break monotonicity assumption 🟢 Low (theoretical)  [S15]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~3183-3195`.
- **Note:** Reviewer concluded "in practice the assumption holds." Lowest
  priority; revisit only if we see missed valid widths in logs.

---

### R31 — `close_all` liquidates CC-collateral shares → naked short call 🔴 Critical  [S(v2)2]
- **Status:** ✅ DONE (2026-06-16). `run_one_cycle`'s stop now sells only
  `_available_qty` (free) shares via a bounded `place_order` sell instead of
  `close_all`/DELETE, and holds+alerts when all shares are CC collateral. cons/agg
  unified onto the manual path's collateral-aware behavior. +3 tests
  (`test_strategy_stop_collateral.py`).
- **Location:** `strategy.py:289, 446` (`run_one_cycle` stop fires
  `close_all(SYMBOL)` → `DELETE /positions/{symbol}`), `strategy.py:181`.
- **Scenario:** cons/agg only. The TSLA wheel is in Stage 2 (100 shares + a sold
  covered call). TSLA falls to the strategy stop. `run_one_cycle` calls
  `close_all("TSLA")`, which `DELETE`s the *entire* position — including the 100
  shares backing the CC — leaving a **naked short call** with uncapped upside
  risk. `run_one_cycle` has no visibility into `wheel_state.json` / the open CC.
- **Cost:** Naked short call on a rally = unbounded loss. live is *not* affected
  (it routes to `run_one_cycle_manual` which uses `_available_qty` and respects CC
  collateral — verified), but cons/agg run the unguarded `close_all` path, and
  it's the worst risk class in the codebase.
- **Fix direction:** Before `close_all` in `run_one_cycle`, consult the wheel
  state / `qty_available`: only liquidate *free* shares (mirror the manual
  `_available_qty` path), or buy-to-close the CC first, or skip+alert if shares
  are CC-locked. Unify cons/agg onto the same collateral-aware exit the manual
  path already uses.
- **Test direction:** Stage-2 position with a CC + stop trigger → assert the bot
  does not naked the call (closes only free shares or buys back the call first).

### R32 — `long_options` hedge guard is PUT-only → naked short call 🔴 Critical  [S(v2)4]
- **Status:** ✅ DONE (2026-06-16). `_unpaired_hedge_long_occs` now also protects
  the long CALL of a call credit spread (short call at a LOWER strike, same
  expiry), type-matched so puts/calls don't cross. +3 tests in
  `test_spread_loss_fix.py`. Closes the naked-short-call hole on manual + live.
- **Location:** `long_options_strategy.py:168-199`, line ~184
  (`if parsed["type"] != "put": continue`).
- **Scenario:** A user hand-opens a **call** credit spread (short call + long
  call at a higher strike) — or the wheel hasn't adopted it yet / state is stale.
  `_unpaired_hedge_long_occs` only recognizes *put* hedges, so the long call is
  not protected. If it's lost >50% (normal after the stock drops), `long_options`
  stop-losses it → the short call is left **naked** (unlimited risk) until noticed.
- **Cost:** Naked short call on the live/manual account — the single most
  dangerous position the bot can accidentally create.
- **Fix direction:** Extend `_unpaired_hedge_long_occs` (and the symmetric
  wheel-side `_short_call_has_live_hedge` if needed) to also detect *call*
  hedges: a long call paired with a short call at a LOWER strike + same expiration
  is the long leg of a call credit spread. Mirror the put block with the strike
  comparison inverted.
- **Test direction:** Short call + long call (higher strike, same expiry) →
  assert the long call is recognized as a hedge and NOT stop-lossed.

### R33 — Live silently falls back to the paper endpoint 🟠 High  [S(v2)7]
- **Status:** ✅ DONE (2026-06-16). `apply_mode` (both `wheel_strategy` and
  `strategy`; `long_options` delegates to `wheel_strategy.apply_mode`) now raises
  `RuntimeError` when `mode == "live"` resolves to the paper endpoint
  (missing/malformed/placeholder/paper `ALPACA_LIVE_BASE_URL`) instead of silently
  trading paper. +10 tests (`test_live_endpoint_guard.py`).
- **Location:** `wheel_strategy.py:143-147` (and identical logic in `strategy.py`,
  `long_options_strategy.py`): a missing/malformed base URL falls back to
  `https://paper-api.alpaca.markets/v2`.
- **Scenario:** `ALPACA_LIVE_BASE_URL` is deleted / typo'd / set to a placeholder.
  `apply_mode("live")` can't parse it → falls back to the paper endpoint. With
  paper creds also present, all calls succeed against the WRONG account — the bot
  "trades" paper while the real-money live account goes completely unmanaged
  (missed stops, unmanaged spreads, uncollected premium).
- **Cost:** Live real-money account left unmanaged — the failure is silent.
- **Fix direction:** For `mode == "live"`, refuse the paper fallback: if the
  resolved `BASE_URL` is the paper default (or the live URL didn't parse), post to
  `#live-errors` and hard-exit instead of silently continuing. Optionally assert
  the live base URL host is `api.alpaca.markets`.
- **Test direction:** live mode + missing/placeholder base URL → assert it raises
  / exits rather than running against paper.

### R34 — `place_buy_to_close` flat +$0.05 overpays on cheap options 🟡 Medium  [S(v2)6]
- **Status:** NOT STARTED.
- **Location:** `wheel_strategy.py:~1499`.
- **Scenario:** The flat `+$0.05` premium added to ensure a fill is a large
  *percentage* on cheap options (e.g. a $0.05-bid option → the add doubles the
  buy-back cost). Applied on every 50%-profit BTC across cons/agg/live.
- **Cost:** Systematic overpayment on cheap-option closes. (Distinct from R4,
  which is about pricing off a *stale* last-trade; this is the flat add itself.)
- **Fix direction:** Replace the flat add with a percentage-based concession
  (e.g. `+max(0.01, price*0.05)`) or price marketable off the live ask. Coordinate
  with R3/R4 (one consistent close-pricing helper).
- **Test direction:** Cheap option → assert the BTC limit isn't a large %
  over-ask.

### Low "needs confirmation" carried from v2
- **`_resolve_pending_spread` stale-detection timezone handling** (naive vs aware
  `datetime` vs `opened_at`): confirm `stale_after_hours` neither never-fires nor
  always-fires. Verify during R7/R13 work.
- **`daily_summary` P&L vs `qty_available` on partial manual sells**: confirm the
  summary doesn't compute P&L on a stale `position_qty` after a partial sell.

## Recently shipped (context)

- **2026-06-16 tripwire noise-tolerance** (manual): DTE≤2 gate + 60-min
  continuous-breach confirmation. R8 above is a follow-up gap in this same
  change (DTE-floor close should not be suppressed during pending confirmation).

## Reviewed and judged NOT bugs (no action)

From the Sonnet pass, these were self-retracted on closer reading and are
recorded so we don't re-open them: call-credit tripwire direction (correct);
`SPREAD_STOP_LOSS_PCT` embed text (already fixed); adopted-call
`contract_order_id=None` (by design — resolution path not reached when the
position exists); concurrency-cap mid-cycle counting (correct); market-order
stop-loss prune-then-state (market orders fill); ETF `premium_yield` low score
(handled by the wheelability bypass); post-assignment orphan long falling to
`long_options` (correct outcome); earnings far-future `delta` handling (correct).
Opus independently verified as solid: live mode-gating (manage-only), CC
collateral protection (`_available_qty`), close-quantity correctness,
max_loss/profit_pct unit consistency, degenerate-quote guards, pending-vs-orphan
ordering, the hedge hand-off, and PDT routing.

## Status tracker

| ID | Title | Phase | Status |
|---|---|---|---|
| R1 | Duplicate-order guard (`client_order_id`) | 1 | ✅ DONE |
| R32 | `long_options` call-hedge guard (naked short call) | 1 | ✅ DONE |
| R31 | `close_all` nakeds a CC (collateral-aware exit) | 1 | ✅ DONE |
| R33 | Live → paper endpoint silent fallback | 1 | ✅ DONE |
| R2 | Average-down HWM/trailing reset | 1 | ✅ DONE |
| R3 | `long_options` exits off stale price | 1 | ✅ DONE |
| R4 | Wheel 50%-close off stale price + reopen race | 1 | NOT STARTED |
| R5 | mleg close market-order bad fills | 2 | NOT STARTED |
| R6 | Fallback close at mid (won't fill) | 2 | NOT STARTED |
| R7 | mleg close success without fill verify | 2 | NOT STARTED |
| R8 | Tripwire pending blocks profit/stop/DTE | 2 | NOT STARTED |
| R9 | DTE-floor `get_latest_price` unguarded | 2 | NOT STARTED |
| R10 | `net_credit=None` crash | 2 | NOT STARTED |
| R11 | Adopted-spread net_credit trust | 2 | NOT STARTED |
| R12 | `normalize_scores` small-pool gate | 2b | NOT STARTED |
| R13 | Null order id reopen loop | 2b | NOT STARTED |
| R14 | Multi-open stale BP | 2b | NOT STARTED |
| R15 | Zero-bid long leg skipped | 2b | NOT STARTED |
| R16 | Earnings window / cons-agg CSP gate | 2b | NOT STARTED |
| R17 | Multi-contract market_value/100 | 3 | NOT STARTED |
| R18 | Stage-2 <100 share misdetect | 3 | NOT STARTED |
| R19 | `place_buy_to_close` full-position close | 3 | NOT STARTED |
| R20 | `_available_qty` seed vs reconcile | 3 | NOT STARTED |
| R21 | Single-leg adoption overwrite | 3 | NOT STARTED |
| R22 | Adopted-spread settle window | 3 | NOT STARTED |
| R23 | Discovery before market-open | 3 | NOT STARTED |
| R24 | STO mid won't fill | 3 | NOT STARTED |
| R25 | cycle_count CC off-by-one | 3 | NOT STARTED |
| R26 | TSLA hardcoded cycle | 3 | NOT STARTED |
| R27 | entry_price KeyError | 3 | NOT STARTED |
| R28 | round_strike off-grid | 3 | NOT STARTED |
| R29 | Duplicate adoption embeds | 3 | NOT STARTED |
| R30 | Width-loop monotonicity | 3 | NOT STARTED |
| R34 | `place_buy_to_close` flat +$0.05 overpay | 3 | NOT STARTED |
