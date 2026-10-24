# Agent account — money-loss remediation (2026-10-24)

Dual-model fresh-context adversarial review (Opus + Sonnet, run in parallel, neither
saw the other or this session's conclusions) of `agent_trader.py`, `agent_config.py`,
`agent_grading.py`, `agent_retrospective.py`, `agent_market_context.py`,
`alpaca_data.py`, `agent-trader.yml`, and the `live_brief.py` read-only invariant.
Prompted by the 2026-10-23 multi-leg limit sign bug. Both reviewers checked the code
against `agent_state.json` + `logs/agent.jsonl`; key claims re-verified by hand
(marked ✔).

**Verdict on the 2026-10-23 sign fix (both models):** correct for what it targets —
two-leg same-expiry vertical OPENS sent as limits, legs in any order — and
incomplete everywhere else (closes, market orders, 3–4 leg structures, calendars).

**`live_brief.py` (real money):** both confirm it cannot place/cancel/modify — it
imports only gathering helpers, every Alpaca call on its path is a GET, and
`_base_url` forces paper even if an order helper were reached. Sonnet notes the
runtime test for it is vacuous (stubs bypass the code it claims to guard); the
invariant holds in code.

## Status tracker

Ordered by: both-model findings first, then dollar severity. `✔` = re-verified in
code/log by hand during triage.

| ID | Sev | Found by | Finding | Status |
|---|---|---|---|---|
| A1 | High | both ✔ | Wrong-signed **closes** — SLB 09-04 (+0.19) and TSLA 09-16 (+5.25) closed debit spreads with positive limits, so both filled at the bid/ask cross; guard exempts closes and a test locks the exemption in | open |
| A2 | High | both | 3–4 leg structures (iron condor, butterfly, straddle, strangle) classify `unknown` → no sign check; `_intent_max_loss` uses outer strike span → wrong-signed condor passes the cap at $50, correctly-signed one is rejected as $1,950–4,420 | open |
| A3 | High | both ✔ | **Market orders** skip the sign check, the 30% cap, and the fill block; CVS 3-lot close was a market mleg (08-21) | open |
| A4 | High | both | **Recorded P&L ≠ real P&L.** Scoreboard −$940 vs account ≈ −$1,104 (equity $896 flat on 10-21). `estimated_pnl` is the last mid snapshot before the close, never the close fill; DIS double-count (−$57 ×2 for a ≈−$56 total) never ages out now that the full history is fed | open |
| A5 | Med-high | both ✔ | ZS `fill` block still says slippage **+0.35 (better)**; truth −0.85. `premium` label is derived from legs, so ZS will be logged `collected` though it paid a debit; lessons drop `fill`. NCLH fill was inverted too | open |
| A6 | Med-high | both | 30% cap is **per order**, not aggregate — three 29% opens in a cycle, or repeats across cycles, all pass | open |
| A7 | Med-high | both | No `client_order_id`; a timeout after Alpaca accepted the order is told to the model as "not placed" → possible duplicate. State saved only at cycle end; a crash/failed push after placement loses tracking. Cancel race leaves an untracked fill | open |
| A8 | Medium | both | Calendars/diagonals classified by strike only → correct positive debit rejected with "use a NEGATIVE limit" (teaches the wrong convention) | open |
| A9 | Medium | both | Unequal leg qty silently rewritten (sell 3 / buy 2 → 2/2; 6/4 → 4/4); state keeps the model's qty | open |
| A10 | Medium | both | Chain snapshots `limit: 1000`, no pagination (SPY/QQQ/TSLA likely truncated); option quotes from `feed=indicative`, not NBBO ✔ — **needs confirmation** | open |
| A11 | Low-med | both | `chosen[:keep]` silently truncates a strike window (can drop the other condor wing / near-money strikes) while reporting `fallback: false` | open |
| A12 | Low-med | both | `load_state` silently returns empty state on corrupt JSON; next save wipes history. Non-atomic write | open |
| A13 | Medium | both ✔ | DST ends 2026-11-01: 14:07 UTC agent fire → 9:07 ET (skips); live brief 13:40 UTC → 8:40 ET (skips daily). cron-job.org hours need +1 | open (owner) |
| O1 | High | Opus | Unfilled **add-on** to an already-held position matches on shared legs → lands in `still_open`, never swept/cancelled, gets a fabricated fill block, and double-counts P&L at close (simulated) | open |
| O2 | Medium | Opus ✔ | Single-leg orders carry **no `position_intent`**; a "close" isn't checked against held legs → "close: buy 3 TSLA calls" opens an untracked, uncapped position | open |
| O3 | Medium | Opus | Expiry-week blind spot: chains fetched 7–45 DTE so held legs <7 DTE lose quotes; no expiry/assignment settlement (NCLH graded 3 days after expiry) | open |
| O4 | Medium | Opus ✔ | Since 2026-09-10 only the 14:xx and 19:xx cycles run — the 16:07/18:07 UTC fires never appear. Check cron-job.org jobs + Actions history | open (owner) |
| S1 | Medium | Sonnet ✔ | `underlying_move_pct_during_hold` is **None for all 8 closed trades** — the mandate says it's there; close-time prices sit unused in `last_snapshot["underlyings"]` | open |
| S2 | Medium | Sonnet | Grader invents hindsight (TSLA lesson: "rallied to 372 by expiry … would-be near-double", `exit_quality: early`) with no post-close data in its payload — teaches "you exit early" on a made-up premise | open |
| S3 | Medium | Sonnet | Agent never sees its own resting orders; swept/unfilled opens are still reported as "opened" | open |
| S4 | Medium | Sonnet | Stock legs: open-sell opens an uncapped short; close has no held-qty check (can flip short); stock buys only bounded by buying power | open |
| S5 | Medium | Sonnet ✔ | Trend stats use `adjustment: raw` bars → splits inside the 370-day window fake −80–90% returns / wrong SMA20 / 52w range | open |
| S6 | Low-med | Sonnet | Sweep cancels fresh orders if a manual dispatch runs minutes after a scheduled cycle; a `filled` tracked order with no snapshot is kept forever (phantom) | open |
| L1 | Low | both | Grade time used as close time (`days_held`, "now" price); failed grade records `breakeven` on a loss; limit −0.004 → "-0.00"; no `max_tokens` stop check; `live_brief` write-test vacuous; retrospective has a native `schedule:` | open |

## Not bugs (investigated and retracted)

- `_intent_net_credit` / `_actual_net_credit` sign math is internally consistent; ZS's
  "+0.35" was arithmetically right for the debit actually sent — the input sign was wrong.
- `_payoff_at_fill` (ZS: max profit −$25, max loss $275) is correct.
- `fair_value` sign handling via signed qty is correct; `_position_qty_is_isolated` works.
- Multi-leg `position_intent` mapping is correct.
- Decision retry cannot double-submit (orders are placed outside the retry).
- Market-closed guard works (fail-open by design); cron double-fires are serialized by `bot-commits`.
- Observe/dry-run skip every write path.

## Fix order (proposed)

1. **Order correctness** — A1, A2, A3, A8, A9, O2, S4: one structure-aware net-price
   classifier (sum signed legs; handles verticals, condors, flies, straddles, calendars)
   drives the sign rule for opens AND closes (auto-correct the sign on closes rather
   than reject), per-structure max loss, no market orders on options/mleg, reject
   non-integer ratios, `position_intent` on single legs, closes validated against held legs.
2. **Exposure** — A6 aggregate open-risk cap, S4 stock notional cap.
3. **Truthful feedback** — A4 realized P&L from actual fills, A5 + O1 per-order fill
   tracking, S1, S2, S3, one-off repair of the ZS/NCLH fill blocks and the DIS double-count.
4. **Robustness** — A7 `client_order_id` + per-placement save, A12, O3, S6, A11.
5. **Data quality** — A10 (confirm, then paginate / feed), S5 split-adjusted bars.
6. **Owner actions** — A13 DST shift, O4 missing fires.

Each fix: verify in code → failing test → fix → suite → commit (reference ID) →
update this tracker + `CHANGELOG`.
