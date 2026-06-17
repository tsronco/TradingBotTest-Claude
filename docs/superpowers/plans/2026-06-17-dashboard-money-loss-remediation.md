# Dashboard money-loss remediation plan (2026-06-17)

## Purpose

The bot (Python) side was just hardened by a dual-model fresh-eyes review
(34 findings, all remediated — see
[2026-06-16-bot-money-loss-remediation.md](2026-06-16-bot-money-loss-remediation.md)).
Per the "Fresh-eyes adversarial review process" in `CLAUDE.md`, the next planned
run is the **same process on the `dashboard/` subproject**. This is that run.

Two independent adversarial code reviews were run with fresh eyes (Opus 4.8 and
Sonnet 4.6, each with no knowledge of how the code was written or of this chat)
on the `dashboard/` TypeScript/React SPA + `dashboard/api/` serverless
functions, briefed to find every way the dashboard moves real money incorrectly,
corrupts P&L bookkeeping, or lets the real-money `live` account do something it
must not.

This document is the reconciled, deduplicated catalog plus a priority-ordered
remediation roadmap. We work it **one finding at a time, in order**, each with
its own verification + test + commit.

## Scope and stance

- **The `live` account is real money** and is the highest-stakes surface. Order
  *placement* is correctly blocked for live (the `LIVE_ENABLED` 403 guard), but
  the review found the **modify/cancel and read paths are NOT gated** (D1) — the
  one place real money is reachable from the dashboard today.
- **The active paper book is `manual` + `sm500/1000/2000`** (the accounts being
  traded right now). Trade-record / P&L-bookkeeping bugs corrupt what you look at
  *today*, and would corrupt `live`'s records the moment placement is enabled.
- Ordering is by **which surfaces actually run the buggy path** (real-money
  reachable first, then the active paper book), then by dollar/impact severity.
- Every finding is re-confirmed against the live code at fix time before we
  change anything — the reviews are a map, not gospel. The one self-retracted
  "not-a-bug" (the mleg sign disagreement) is recorded at the end so we don't
  re-litigate it.
- Source tags: **O#** = Opus finding number, **S#** = Sonnet finding number.

## Which surfaces run which code path (prioritization key)

A bug only matters to a surface that executes the path.

| Code path | live (real $, placement gated OFF) | manual / cons / agg (paper) | sm500/1k/2k (paper) |
|---|---|---|---|
| Order **submit** (`trades/submit`, `submitSpread`, `import`) | ❌ blocked by `LIVE_ENABLED` | ✅ | ✅ |
| Order **modify / cancel** (`alpaca/modify-order`, `cancel-order`) | ✅ **gated by D1 fix** | ✅ | ✅ |
| **Read** account / positions / orders (`alpaca/[endpoint]` GET) | ✅ intentionally ungated (D1 decouple — Low risk) | ✅ | ✅ |
| **Auth** (login / session / TOTP / backup codes) | ✅ gates everything | ✅ | ✅ |
| **Trade-record lifecycle** (submit + grade-cron sync / close detect) | ✅ records when on | ✅ | ✅ |
| **Import** from Alpaca activity log | ✅ | ✅ | ✅ |
| **Rule-check / exposure / TOTP-threshold** | ✅ | ✅ | ✅ |

Takeaways:
- **Order placement is correctly blocked for live, but modify/cancel + reads are
  not (D1).** That is the only path that moves real money from the dashboard
  today. Fix first.
- **Double-place (D2)** doubles a *paper* position now and would double a *live*
  order the moment placement is enabled. Real-money-class, bot-R1 cousin.
- **Trade-record / P&L bugs (D4–D7, D11, D13, D14)** bite the active paper book
  (manual + SM) right now — wrong/lost P&L, stuck-open trades, phantom records.
- **Auth bugs (D3, D8, D10)** gate every account, including live placement.

## Working agreement (how we execute this plan)

1. Take findings strictly in the order below unless a dependency forces a swap.
2. For each: (a) re-read the code and confirm the bug is real and as described;
   (b) write/extend a **failing** vitest that captures it; (c) implement the fix;
   (d) run the dashboard suite (`cd dashboard && npx vitest run --pool=threads`);
   (e) commit with a message referencing the finding ID; (f) update this file's
   status table and the dashboard `CHANGELOG` (`src/data/changelog.ts`).
3. One finding per commit where practical, so each is independently revertible.
4. **Subagent-driven execution** — a fresh subagent implements each finding
   (verify → failing test → fix → suite), then it's reviewed and committed before
   the next. No live-money code path is touched without a guard + test.
5. After each fix, report back before starting the next.

---

## Priority roadmap

### PHASE 1 — Tier 1: real-money order path (fix before any live use)

| ID | Severity | Surfaces | Title |
|---|---|---|---|
| D1 | 🔴 Critical | live (real $) | `modify-order` / `cancel-order` (and GET reads) have **no `LIVE_ENABLED` gate** — real orders re-priced/cancelled with live "off" |
| D2 | 🔴 Critical | live + all paper | **No idempotency key** on any order submit → dropped-response retry double-places a real order (bot-R1 cousin) |

### PHASE 2 — Tier 2: trade-record & P&L integrity (corrupts the active paper book now)

| ID | Severity | Surfaces | Title |
|---|---|---|---|
| D4 | 🟠 High | all | Month-index written read-modify-write → concurrent submit/import drops a trade from history (no P&L, no grading) |
| D5 | 🟠 High ✅ | all (import) | Closing fills (`side: sell` = BTC) imported as STO **opens** → phantom duplicate trades |
| D6 | 🟠 High | all (spreads) | Spread `syncFillData` skips the modify-chain walk → a modified spread is stuck "unfilled" forever |
| D7 | 🟠 High | all | `syncFillData` re-runs every cron tick for filled/no-modify trades; a throttle/error then **blocks `detectClose`** → trade stuck open, P&L never recorded |
| D13 | 🟡 Medium | active accounts | `findClosingFill` fetches only 1 page (100 activities) → on busy accounts the close is missed → trade stuck open |
| D11 | 🟡 Medium | manual, live | Past-expiry STO booked "expired worthless" when settlement unconfirmed → **assigned shares go invisible**; null `filled_avg_price` ⇒ P&L = 0 |
| D14 | 🟢 Low | manual, SM | Spread-close P&L uses pre-fill mid (`net_credit`) when `syncFillData` hasn't run yet → minor P&L inaccuracy |

### PHASE 3 — Tier 3: auth hardening (gates all order placement)

| ID | Severity | Surfaces | Title |
|---|---|---|---|
| D3 | 🟠 High | all | Backup-code consumption is read-modify-write → single-use guarantee racy |
| D8 | 🟠 High | all | Per-IP login lockout trusts leftmost `X-Forwarded-For` → spoof rotates "IP" → brute-force on password + TOTP/backup |
| D10 | 🟡 Medium | all | Session token has **no server-side age check** → a stolen/old cookie is valid indefinitely |

### PHASE 4 — Tier 3: risk-sizing & latent P&L

| ID | Severity | Surfaces | Title |
|---|---|---|---|
| D9 | 🟡 Medium | all (TOTP gate) | Short-**call** exposure uses premium, not assignment notional → undersized → skips the TOTP threshold (incl. live) |
| D12 | 🟡 Medium | manual, live (latent) | Debit-spread close P&L is mis-signed (uses `net_credit` = 0) → a winning debit spread books as a loss |
| D15 | 🟢 Low | all (import) | Import cursor `after: since.slice(0,10)` is date-granular → month-boundary re-import → duplicate trade records |

---

## Finding detail

Each entry: **location → scenario → why it costs money → fix direction → test
direction → status.**

### D1 — `modify-order` / `cancel-order` (and GET reads) have no `LIVE_ENABLED` gate 🔴 Critical  [O1, S10; read-side O9]
- **Status:** ✅ DONE (2026-06-17). Added `liveGuard()` helper to `api/_lib/alpaca.ts`; wired inside the `modify-order` and `cancel-order` branches only (writes-only decouple, 2026-06-17). GET reads (account/positions/orders/equity-history) are intentionally left ungated so live monitoring keeps working without `LIVE_ENABLED`; O9 read-exposure accepted as Low risk (single-user, read-only). 13 new vitest tests cover modify/cancel gating (live blocked, live enabled passes, paper always passes) and read passthrough (live reads pass through even with `LIVE_ENABLED` unset).
- **Location:** `dashboard/api/alpaca/[endpoint].ts` — `modify-order` branch (~324–362) and `cancel-order` branch (~363–389) read `mode` from `req.query.mode` via `modeFromQuery` (which returns `'live'`) and call `alpacaTradeMutation('live', …)` (real endpoint). GET reads (`account`/`positions`/`orders`/`equity-history`, ~45–322) are likewise ungated. The submit guard exists at `trades/[action].ts` (`draft.account === 'live' && process.env.LIVE_ENABLED !== 'true'` → 403) but was never mirrored here. UI reaches it: `accountsForSelection` (`src/lib/account-utils.ts:82,92–99`) admits `live`; `Orders.tsx:318–334` renders live `[modify]`/`[cancel]` wired to `mode=live`.
- **Scenario:** With a real working order on `live`, an authenticated session PATCHes its limit to a fill-immediately price (or cancels it) — no `LIVE_ENABLED`, no TOTP. PATCHing a resting limit is an economic action; dragging a sell limit to marketable dumps a real position at a bad price.
- **Cost:** Direct real-money loss / unintended execution on the live account, while the whole app's posture is "live is disabled."
- **Fix direction:** Add `if (mode === 'live' && process.env.LIVE_ENABLED !== 'true') return res.status(403).json({error:'live_disabled'})` at the top of both the `modify-order` and `cancel-order` branches (mirror the submit guard). Gate the live GET reads the same way (or behind an explicit read flag) to match the "live off" posture. Consider TOTP-gating live modify like submit does. Centralize as a shared `assertLiveAllowed(mode, res)` helper so future endpoints can't forget it.
- **Test direction:** vitest: `mode=live` + `LIVE_ENABLED` unset → modify-order and cancel-order each return 403 and make **no** Alpaca mutation call; `LIVE_ENABLED='true'` → passes through; paper modes always pass.

### D2 — No idempotency key on order submit → retry double-places 🔴 Critical  [O2, S3; bot-R1 cousin]
- **Status:** ✅ DONE — fully closed (2026-06-17). Two commits:
  1. *(c07595ca)* Stable `client_order_id` stamped on every stock/option `createOrder` and mleg `alpacaBody`; duplicate-422 resolved via `GET /v2/orders:by_client_order_id`; `ConfirmModal` generates one UUID in a `useRef` (stable across re-renders/re-clicks) and disables the button synchronously before any `await`. 9 new vitest tests (5 server-side, 4 client-side). Prevented double Alpaca orders, but still created a second trade record on cross-request retry.
  2. *(this commit)* KV idempotency index (`trades:idem:<key>` → trade id, 7-day TTL, `nx: true` atomicity) added to `claimIdemIndex()` in `[action].ts`. Checked before `allocateTradeId()` and before any Alpaca call in both `submit` and `submitSpread`: index hit or lost-nx-claim → load existing trade and return immediately, no new record. Closes the trade-record dedup gap. 2 new vitest cross-request tests; full suite: 14 pre-existing failures only.
- **Location:** `dashboard/api/trades/[action].ts` — stock/option `createOrder(orderPayload)` (~630), spread `alpacaBody` mleg POST (~405–415), import opens (~1267+). None set `client_order_id`. Client: `src/components/order/ConfirmModal.tsx:44–66` (button disabled only after `setSubmitting(true)`); `src/lib/api.ts` POST has no idempotency token.
- **Scenario:** User places an order; Alpaca creates it but the HTTP response is lost (network blip, Vercel cold-start timeout, mobile handoff). `api()` throws, `setSubmitting(false)` re-enables the button, the user clicks again → a second byte-identical POST → **two real fills**. (A naive double-*click* is already blocked by `submitting`; the live exposure is specifically the dropped-response/retry path.)
- **Cost:** Doubled real-money position / premium on live; doubled paper position elsewhere. The changelog already records the *bot* fixing exactly this (R1, `client_order_id`); the dashboard never got it.
- **Fix direction:** Stamp a deterministic `client_order_id` (e.g. from a pre-allocated trade id or a hash of account+symbol+side+strike+expiry+qty+minute-bucket) on every `createOrder` / mleg POST; on a submit error, look the order up by `client_order_id` before allowing a re-submit. Belt-and-suspenders: make `ConfirmModal.place()` disable the control as the first synchronous statement before any `await`.
- **Test direction:** vitest: submit builds a stable `client_order_id`; a simulated dropped-response retry with the same draft does not place a second logical order (dedup by client id); the modal handler is idempotent across two rapid invocations.

### D4 — Month-index trade record is read-modify-write (lost update) 🟠 High  [S1, O5]
- **Status:** ✅ DONE (2026-06-17). Added `readMonthIndex(month)` and `appendMonthIndex(month, id)` helpers to `dashboard/api/_lib/kv-keys.ts`. Both use atomic `lrange`/`rpush` (mirroring the open index). Legacy `'string'`-type keys (JSON-array format, written by the old code) are migrated in-place on first touch: `lrange` throws WRONGTYPE → catch → `get` the array + `del` the string key + `rpush` all ids as a list. Detection uses try-catch on WRONGTYPE rather than `type()` so existing test mocks without `type()` degrade gracefully. All 6 writer call sites converted from get-then-set to `appendMonthIndex`; all 5 reader call sites converted from `get` to `readMonthIndex` (in `trades/[action].ts` list/calendar/performance/orderIdAlreadyImported and `cron/[job].ts` loadClosedTrades/appendMonthIndex). `rule-check.ts` reader also updated. 9 new vitest tests: two-concurrent-append survival, sequential accumulation, empty key, fresh list key read, legacy string key read, legacy key migration to list, migrated key ids preserved, append-to-legacy-key migration, concurrent-legacy-append survival. Full suite: 646/646 (637 baseline + 9 new). **Migration dedup-hardened (2026-06-17):** `migrateStringToList` now dedups ids before `rpush` (belt-and-suspenders within a single migration call); `readMonthIndex` applies `[...new Set(ids)]` on every lrange result (robust against the concurrent-reader migration race: two Lambda invocations both catching WRONGTYPE on the same legacy key and both pushing the same ids twice into the list). 2 additional vitest tests prove duplicates are collapsed: `two concurrent readers of a legacy key return no duplicate ids` and `readMonthIndex dedups even when a list key has duplicate entries at rest`. Full suite after hardening: 648/648.
- **Location:** `dashboard/api/trades/[action].ts` — `get<string[]>(monthKey)` then `set(monthKey, [...monthList, id])` at ~499–501 (spread), ~721–723 (stock/option submit), ~1395–1397 and ~1481–1483 (import). The open index correctly uses `rpush`/`lrem`; the *month* index does not. `kv-keys.ts` even warns against RMW on `trades:index:open` — same hazard, not applied here. The grade-cron's auto-import (`cron/[job].ts`) appends to the same month key concurrently.
- **Scenario:** A user submit races the 5-min auto-import (or two tabs) on the same `trades:index:YYYY-MM` key. Both read before either writes; one appended id is overwritten.
- **Cost:** The `trade:T-…` record survives but vanishes from `/trades`, `/calendar`, `/performance`, and the tendency cron — its P&L silently drops out of every rollup and it's never AI-graded. On a live trade, realized P&L never recorded.
- **Fix direction:** Make the month index a Redis list written with `rpush(tradesIndexMonthKey(month), id)` and read with `lrange` (mirror the open index; the cron already uses `lrange` on the assignment month push). Migrate readers; one-time backfill of existing JSON-array month keys into lists.
- **Test direction:** vitest with the KV mock: two concurrent appends to the same month key both survive (list semantics); readers return both ids.

### D5 — Closing fills imported as STO opens → phantom trades 🟠 High  [S4]
- **Status:** ✅ DONE (2026-06-17). Added `position_effect?: string` to the `RawFill` interface in `dashboard/api/trades/[action].ts`. Pre-filter `activities → openingFills` inserted before `groupFillsIntoSpreadsAndSingles`: any fill whose `position_effect` normalises to `'closing'` is skipped; absent/undefined defaults to opening (safe — must not silently drop genuine opens from legacy records). 4 new vitest tests: (1) STO-open + BTC-close stream imports exactly one trade (the open); (2) lone closing fill imports nothing; (3) closing spread pair (both legs `position_effect:'closing'`) imports neither spread nor singles; (4) fill with no `position_effect` still imports (safe-default). Full suite: 652/652 (648 baseline + 4 new).
- **Location:** `dashboard/api/trades/[action].ts:1412–1419` — `if (sideRaw === 'sell_short' || sideRaw === 'sell') side = 'STO'`. Alpaca uses `side:'sell'` for **both** short-open (STO) and buy-to-close is `buy`… but a sell-to-close (STC) of a long and a sell-to-open both surface as `sell`; more importantly a BTC close of a short carries `side:'buy'` and is treated as a BTO **open**. Net: closing fills are misclassified as opens. Dedup (`orderIdAlreadyImported`) keys on the *open* order id, so the close (different order id) passes.
- **Scenario:** The 5-min auto-import window slides over a closing fill; it's imported as a fresh "open," added to `trades:index:open`, consumes a trade id, and on its first cron pass `detectClose` queries a position that's already gone → spurious Path-3 external-close with fabricated P&L.
- **Cost:** Phantom trades inflate open-count and corrupt `/trades` P&L history (bookkeeping integrity on the active book).
- **Fix direction:** Use Alpaca's `position_effect` (`opening`/`closing`, present on FILL activities) to import **opening** fills only; or skip any fill whose timestamp is after an existing trade record for the same OCC. Add `position_effect` to the activity type.
- **Test direction:** vitest: an activity stream containing an STO open followed by its BTC close imports exactly one (opening) trade; a lone closing fill imports nothing.

### D6 — Spread `syncFillData` skips the modify-chain walk → modified spread stuck unfilled 🟠 High  [S5]
- **Status:** ✅ DONE — 2026-06-17. Extracted `fetchOrderById` + `walkToTerminal` helpers at the top of `syncFillData` (shared by both paths). Spread branch now calls `walkToTerminal` before reading fill status, repoints `alpaca_order_id` to the terminal order, and proceeds identically to before for reading leg fill prices. Iteration cap 10 hops + cycle guard (`seen` set) prevents infinite loops on malformed chains. 4 new vitest tests covering: single-hop replaced→filled, multi-hop (A→B→C filled), malformed/cyclic termination, and pending-not-filled repoint.
- **Location:** `dashboard/api/cron/[job].ts` — spread branch of `syncFillData`; single-leg path updated to use shared `fetchOrderById` / `walkToTerminal` (removing the now-redundant inline `fetchOrder` closure).

### D7 — `syncFillData` re-runs every tick; a throttle then blocks close detection 🟠 High  [S2]
- **Status:** ✅ DONE (2026-06-17). Added `fill_confirmed?: boolean` to the `Trade` type in `dashboard/api/_lib/trade-types.ts`. `syncFillData` now early-returns immediately when `trade.fill_confirmed` is true (before any Alpaca call). The sentinel is written alongside `filled_at` at both fill-confirmation sites: the spread (mleg) path and the single-leg path. Legacy/pre-D7 trades (undefined sentinel) fall through and confirm once, then the next tick is free. Separately, the per-trade loop in `runGradeOpenTrades` now wraps `syncFillData` in a try/catch so a thrown error (edge case — inner `fetchOrderById` already swallows its own errors) cannot skip `detectClose`. The try/catch was verified not redundant by D7c test: `fetchOrderById` logs and returns null on 429/error, so `syncFillData` currently returns `trade` unchanged rather than throwing — the outer guard is belt-and-suspenders against future changes. 3 new vitest tests: D7a (fill_confirmed set → no entry-order Alpaca fetch at all); D7b (fill_confirmed absent, filled order → fetches once and writes fill_confirmed:true); D7c (syncFillData entry-order fetch throws 429 → detectClose still runs, trade correctly closed). Full suite: 659/659 (656 baseline + 3 new).

### D13 — `findClosingFill` fetches only one page (100 activities) 🟡 Medium  [S12]
- **Status:** ✅ DONE (2026-06-17). `findClosingFill` replaced with a paginated loop: fetches up to `MAX_FILL_PAGES=10` pages of 100 activities each (1 000 activities max), advancing via `page_token` (the `id` of the last item on each page, per Alpaca's activities API). Returns the matching fill as soon as it is found (early exit — no over-fetching). Stops early when a page returns fewer than 100 items (end of stream). If the 10-page cap is hit without a match, `console.log` emits `"findClosingFill page cap reached"` so a silently-missed close is visible in Vercel function logs. 3 new vitest tests: D13a (matching fill on page 2 — pagination happens, trade is closed); D13b (no match across all pages — returns null, stops at or before 10 pages, no infinite loop); D13c (page cap hit — log message containing `"findClosingFill page cap"` is emitted). Full suite: 662/662 (659 baseline + 3 new).

### D11 — Past-expiry STO mis-booking: assigned shares invisible / null-fill P&L=0 🟡 Medium  [O8, S11]
- **Status:** ✅ DONE (2026-06-17). Conservative backstop posture: when `resolveOptionSettlement` returns null past `SETTLEMENT_BACKSTOP_MS`, the code now (1) guards null `filled_avg_price` — leaves trade open + warns rather than booking P&L=0; (2) cross-checks `/v2/positions/{underlying}` for assignment evidence — if the position has qty ≥ 100×contracts, books `'assigned'` so the spawn fires and the delivered shares get a trade record; if no position (404) or insufficient qty, leaves the trade OPEN and logs a visible `[D11]` warning rather than fabricating an expired-worthless win. The confirmed-settlement path (OPEXP/OPASN activity found) is completely unchanged. Known heuristic limitation documented in-code and test file: cannot distinguish a freshly-assigned position from pre-existing shares; accepted tradeoff — a false-positive 'assigned' creates a visible spawned stock trade the user can delete, whereas a false-negative 'expired' creates invisible real equity with a wrong P&L. 4 new vitest tests (D11a: assignment evidence detected → books 'assigned' + spawn; D11b: no position → stays open + warning; D11c: null fill price → stays open + warning; D11d: confirmed OPEXP → books 'expired', no regression). 1 pre-existing test updated: "backstop closes as 'expired'" → "D11: no activity, no stock position → trade stays OPEN" (reflects the new conservative behavior). Full suite: 666/666 (662 baseline + 4 new).
- **Location:** `dashboard/api/cron/[job].ts:575–591` (Path 2 expiry booking) with backstop (`SETTLEMENT_BACKSTOP_MS`, ~28/583); assignment spawn only fires on `closed_by === 'assigned'` (~170–175). (a) When `resolveOptionSettlement` returns null past the 3-day backstop, the contract is booked `closed_by:'expired'` with full premium kept (a win) — if it was actually **assigned**, the spawn never fires and the 100 delivered shares get no trade record (invisible on exposure/P&L). (b) `realized_pnl: (trade.filled_avg_price ?? 0) * 100 * qty` ⇒ if `filled_avg_price` is null, P&L books as **0** (breakeven) instead of the real premium.
- **Scenario:** Live short put expires ITM and is assigned, but OPASN activity doesn't post within the backstop → booked as an expired-worthless win; the real long-stock position is untracked.
- **Cost:** Untracked real equity position on live; wrong win/loss + win-rate + grader context.
- **Fix direction:** When settlement is unconfirmed past the backstop, cross-check `/v2/positions/{underlying}` for newly delivered shares before booking "expired"; prefer leaving the trade open / flagging for review over assuming worthless. Guard the null `filled_avg_price` case (don't book P&L=0 silently).
- **Test direction:** vitest: unconfirmed past-backstop STO with shares present in positions → not booked expired (or booked assigned + spawn); null `filled_avg_price` does not silently produce P&L 0.

### D14 — Spread-close P&L uses pre-fill mid when `syncFillData` hasn't run 🟢 Low  [S7]
- **Status:** ✅ DONE (2026-06-17). The gap was narrower than described: it only fires on legacy pre-D7 spread trades that have `filled_at` set AND non-empty `modify_history` (so `syncFillData` hits the legacy short-circuit at line 364) but `fill_confirmed` absent and `net_credit` still the decision-time target mid. In the common post-D7 path, `syncFillData` sets `filled_at` + `fill_confirmed: true` + real `net_credit` atomically, so `detectExternalSpreadClose` always sees the confirmed value. Fix: added an early-return guard in `detectExternalSpreadClose` — if `!trade.fill_confirmed`, defer the close (return null) so the next cron tick's `syncFillData` can confirm the real entry credit first. A 24h backstop (`D14_BACKSTOP_MS`) overrides the defer after that window and books with a `[D14]` console.warn noting the approximation. The existing `fill_confirmed` path (`detectExternalSpreadClose` body after the guard) is unchanged. 3 new vitest tests: D14a (legacy unconfirmed spread — deferred, no close booked); D14b (confirmed spread — books immediately with real credit); D14c (>24h backstop — books with warn). Full suite: 669/669 (666 baseline + 3 new).

### D3 — Backup-code consumption is read-modify-write (single-use racy) 🟠 High  [O4, S9]
- **Status:** ✅ DONE (2026-06-17). Replaced the `get<string[]> → includes → push → set` sequence with a single atomic `SADD auth:used-backup-codes:v2 <hash>`. `SADD` returns 1 (newly added → accept) or 0 (already in set → reject); no read-modify-write, no race window. The old JSON-array key (`auth:used-backup-codes`) is checked read-only during the transition window so previously-consumed codes remain rejected before a key rotation. `regenerateBackupCodes` now `del`s both keys on rotation. 6 new vitest tests: `sadd` called with v2 SET key on valid first use; `sadd=0` rejects (already used); legacy array check rejects before sadd; concurrent-use D3 race test (both calls fire before either resolves — exactly one returns true, one false); env-var fallback still works; code not in allowed list is rejected before sadd. Updated mocks in `tests/api/settings-backup-codes.test.ts` (add `del`) and `tests/api/auth-login.test.ts` (add `sadd`). Full suite: 671/671 (0 failures).
- **Location:** `dashboard/api/_lib/backup-codes.ts:30–40` — `get<string[]>(USED_KEY)` → `includes` check → `push` → `set`. Two concurrent logins with the same code both read it as unused, both succeed.
- **Scenario:** Same backup code submitted twice within a tick (made trivial by D8's defeated rate-limit) → consumed twice → two authenticated sessions.
- **Cost:** Single-use guarantee broken → an old/leaked backup code authenticates more than once → order-placement access.
- **Fix direction:** Atomic mark-consumed: `SADD auth:used-backup-codes:v2 <hash>` and treat add-count 0 as "already used", replacing the get-then-set on a JSON array.
- **Test direction:** vitest with KV mock: two concurrent `consumeBackupCodeIfValid` with the same code → exactly one returns true.

### D8 — Login rate-limit trusts leftmost `X-Forwarded-For` (spoofable) 🟠 High  [O3]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/_lib/rate-limit.ts:26–33` (`clientIp` = `xff.split(',')[0]`), used by `auth/[action].ts:22–27,42,53`. Lockout key `auth:fail:<ip>`.
- **Scenario:** Attacker rotates the client-supplied `X-Forwarded-For` per request → every attempt looks like a new IP → the 5-fails/15-min lockout never trips → online brute-force of `DASHBOARD_PASSWORD` + TOTP/backup proceeds unthrottled.
- **Cost:** The only throttle on order-placement auth is defeated. (Mitigated by needing the password too; still a real hardening hole.)
- **Fix direction:** Derive the client IP from Vercel's trusted hop — `x-vercel-forwarded-for` or `x-real-ip` (Vercel-set, not client-appendable) — rather than the leftmost `x-forwarded-for`. **Verify Vercel's exact header behavior at fix time.** Add a global per-account failure counter independent of IP as a backstop.
- **Test direction:** vitest: forged multi-hop `X-Forwarded-For` resolves to the trusted-hop IP, so N failures from one real client still lock out; the global counter trips regardless of IP.

### D10 — Session token has no server-side expiry 🟡 Medium  [S8]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/_lib/session.ts:24–43` — `decodeSession` verifies the HMAC but never checks `loggedInAt` against `MAX_AGE_SECONDS` (that 30-day value is only applied to the browser cookie `maxAge`).
- **Scenario:** A copied/stolen session cookie (browser export, device access, a leaked log) is accepted by the server indefinitely.
- **Cost:** Indefinite order-placement access from a single leaked cookie.
- **Fix direction:** In `decodeSession`, reject when `Date.now()/1000 − session.loggedInAt > MAX_AGE_SECONDS`.
- **Test direction:** vitest: a token with `loggedInAt` older than `MAX_AGE_SECONDS` decodes to null; a fresh one passes.

### D9 — Short-call exposure understates risk → skips TOTP gate 🟡 Medium  [O7]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/_lib/exposure.ts:42–45` — STO **put** uses `strike × qty × 100` (correct collateral); STO **call** falls through to `qty × px × 100` (premium received, not assignment/short-stock risk). `requires_totp = exposure >= threshold` (`trades/[action].ts:529`), so a short call is graded tiny and sails under the threshold (live threshold $1,500); recorded `exposure_at_submit` is wrong. The UI preview (`OptionOrderForm.tsx:72–80`) already uses `strike × 100 × qty` — the server is *less* conservative than the client.
- **Scenario:** A covered/naked short call on live is sized off premium → no TOTP re-prompt; risk review sees a wrong (tiny) exposure.
- **Cost:** Real-money short-call write bypasses the TOTP guard and is mis-sized in records.
- **Fix direction:** Mirror the put branch for STO calls (`strike × qty × 100`, i.e. shares-called-away notional) so call writes are TOTP-gated and recorded correctly.
- **Test direction:** vitest: STO call exposure equals `strike × qty × 100`; a live short call above threshold sets `requires_totp`.

### D12 — Debit-spread close P&L mis-signed (uses `net_credit` = 0) 🟡 Medium  [O6]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/cron/[job].ts:728–767` (`detectExternalSpreadClose`) and ~613–651 (Path 2b expiry); `spreadMath` stores `net_credit: 0` for `put_debit`/`call_debit` (`trades/[action].ts:110–117`). Close P&L `(net_credit − netDebitToClose) × 100 × qty` is always ≤ 0 for a debit spread, and the Path-2b expiry geometry assumes credit-spread shape.
- **Scenario:** A debit vertical opened via the Strategy Builder on manual/live, closed externally or held to expiry → wrong realized P&L (a winning debit spread books as a loss).
- **Cost:** Wrong P&L on debit spreads. Latent today (credit spreads dominate; no debit vertical opened yet) but fully reachable via the form.
- **Fix direction:** Derive close P&L from `net_debit` for debit types (or compute generically from leg fills + `max_profit`/`max_loss`) instead of assuming `net_credit`.
- **Test direction:** vitest: a `call_debit`/`put_debit` closed above cost books a positive realized P&L; a losing one books the bounded debit loss.

### D15 — Import cursor date-truncation → month-boundary duplicates 🟢 Low  [S13, S14]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/trades/[action].ts:1261–1264` — `after: since.slice(0,10)` (Alpaca's `after` is date-granular). Re-offers all fills from the cursor date; dedup (`orderIdAlreadyImported`) only checks the *current* month's index, so a cursor on a month boundary checks the wrong month and re-imports.
- **Scenario:** Importer runs with a cursor on the last day of a month; a fill imported into the prior month re-imports into the new month.
- **Cost:** Duplicate trade records inflate win count + total realized P&L on `/performance`.
- **Fix direction:** Dedup across the boundary (check both adjacent months, or key dedup globally), and/or filter returned fills to `timestamp >= since` client-side.
- **Test direction:** vitest: a fill already imported on the prior month is not re-imported when the cursor crosses the month boundary.

---

## Reviewed and judged NOT a bug — stale tests corrected

- **14 pre-existing failing tests in 3 cron test files** (`cron-grade-open-trades.test.ts`, `cron-external-close-detect.test.ts`, `cron-assignment-close-detect.test.ts`). Root cause: **stale tests, not a code bug.** Two independent issues:
  1. `runAutoImport()` was added to `runGradeOpenTrades()` after these tests were written. It unconditionally writes `import:cursor:<account>` KV keys for all 6 accounts and calls `alpacaTrade` with `conservative` mode via `runImport`. Tests that asserted `kvSet.not.toHaveBeenCalled()` or that `conservative` was absent from modes used failed because `runAutoImport` is an always-on side-effect of the cron tick. **Fix:** added `vi.mock('../../api/trades/[action]')` with a stubbed `runImport` to all 3 files (blocks the `alpacaTrade` calls); changed `kvSet.not.toHaveBeenCalled()` to `kvSet.not.toHaveBeenCalledWith(expect.stringContaining('trade:'), expect.anything())` to allow cursor writes while still asserting no trade record was written.
  2. Several tests used option expirations that were future when written (May 29, June 5) but are now past (June 17). `detectClose` Path 2 / backstop / Path 2b fired at real `Date.now()` and auto-closed trades the tests expected to leave open. **Fix:** added `vi.useFakeTimers()` / `vi.setSystemTime(...)` to freeze clock before all expirations in the affected tests.
  The cron code itself is correct — `modeFromAccount()` properly routes SM accounts to their own Alpaca creds. No production code changed.

## Reviewed and judged NOT a bug (no action)

- **mleg `limit_price` sign convention** [Sonnet F6, SUSPICIOUS] — Sonnet flagged
  the dashboard's negative `limit_price` for credit spreads as possibly inverted,
  claiming "the bot uses a positive value." **Verified false.** The bot's
  `_open_spread_mleg` (`wheel_strategy.py:3246`) sends
  `limit_price = f"{round(-eff_credit, 2):.2f}"` — i.e. **negative** for a credit,
  identical to the dashboard (`trades/[action].ts:409`). The bot opens credit
  spreads with a negative limit on the SM accounts and they fill reliably in
  paper — empirical proof the convention is correct. Opus independently cleared
  the same code. No change. (If credit spreads ever fill as debits on the
  dashboard, revisit — but wire format is byte-identical to the proven bot path.)

## Verified solid (covered, believed correct)

From both reviews' "looks solid" sections, re-noted so we know what was checked:
- **Live-vs-paper endpoint routing on placement** (bot-R33 cousin): `credsFor(mode)`
  + `tradingBase(mode)`/`isLiveMode(mode)` derive creds **and** base URL from the
  same `mode`; they can't desync. Live placement is blocked before the buggy SDK
  is reached. The D1 hole is *authorization*, not misroute.
- **Spread sign convention on open** and credit-spread `max_loss`/credit/exposure
  math; **STO-put collateral** exposure.
- **Live placement guard** consistently applied on `submit`/`submitSpread`/`import`.
- **`trades:index:open` atomicity** (`rpush`/`lrem`/`lrange`) — only the *month*
  index breaks it (D4).
- **Session HMAC** uses `timingSafeEqual` + length guard, rejects unset secret
  (the gap is *expiry*, D10, not signature). **TOTP** is library-backed.
- **Rule-check re-runs server-side** with fresh Alpaca positions (client warnings
  not trusted; block override needs a 20+ char reason server-side).
- **`cancel-order`** refuses to mark a *filled* trade canceled (no false zero-P&L
  close). **Trade-id** allocation uses atomic `INCR`. **Assignment spawn** is
  idempotent (`assignmentChildKey`). **Bot-state webhook** key whitelist holds.

---

## Status tracker

| ID | Title | Phase | Status |
|---|---|---|---|
| D1 | Live modify/cancel/read missing `LIVE_ENABLED` gate | 1 | ✅ DONE |
| D2 | No idempotency key on submit (double-place) | 1 | ✅ DONE |
| D4 | Month-index read-modify-write lost update | 2 | ✅ DONE |
| D5 | Closing fills imported as opens (phantom trades) | 2 | ✅ DONE |
| D6 | Spread `syncFillData` skips modify-chain | 2 | ✅ DONE |
| D7 | `syncFillData` every-tick + blocks close detection | 2 | ✅ DONE |
| D13 | `findClosingFill` single-page cap | 2 | ✅ DONE |
| D11 | Past-expiry STO mis-booking (assigned invisible) | 2 | ✅ DONE |
| D14 | Spread-close pre-fill-mid P&L | 2 | ✅ DONE |
| D3 | Backup-code consumption race | 3 | ✅ DONE |
| D8 | `X-Forwarded-For` rate-limit bypass | 3 | ⬜ TODO |
| D10 | No server-side session expiry | 3 | ⬜ TODO |
| D9 | Short-call exposure understates → TOTP skip | 4 | ⬜ TODO |
| D12 | Debit-spread close P&L mis-signed | 4 | ⬜ TODO |
| D15 | Import cursor date-truncation duplicates | 4 | ⬜ TODO |
