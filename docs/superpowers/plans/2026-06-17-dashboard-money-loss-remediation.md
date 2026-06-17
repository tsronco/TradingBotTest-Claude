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
| D5 | 🟠 High | all (import) | Closing fills (`side: sell` = BTC) imported as STO **opens** → phantom duplicate trades |
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
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/trades/[action].ts` — stock/option `createOrder(orderPayload)` (~630), spread `alpacaBody` mleg POST (~405–415), import opens (~1267+). None set `client_order_id`. Client: `src/components/order/ConfirmModal.tsx:44–66` (button disabled only after `setSubmitting(true)`); `src/lib/api.ts` POST has no idempotency token.
- **Scenario:** User places an order; Alpaca creates it but the HTTP response is lost (network blip, Vercel cold-start timeout, mobile handoff). `api()` throws, `setSubmitting(false)` re-enables the button, the user clicks again → a second byte-identical POST → **two real fills**. (A naive double-*click* is already blocked by `submitting`; the live exposure is specifically the dropped-response/retry path.)
- **Cost:** Doubled real-money position / premium on live; doubled paper position elsewhere. The changelog already records the *bot* fixing exactly this (R1, `client_order_id`); the dashboard never got it.
- **Fix direction:** Stamp a deterministic `client_order_id` (e.g. from a pre-allocated trade id or a hash of account+symbol+side+strike+expiry+qty+minute-bucket) on every `createOrder` / mleg POST; on a submit error, look the order up by `client_order_id` before allowing a re-submit. Belt-and-suspenders: make `ConfirmModal.place()` disable the control as the first synchronous statement before any `await`.
- **Test direction:** vitest: submit builds a stable `client_order_id`; a simulated dropped-response retry with the same draft does not place a second logical order (dedup by client id); the modal handler is idempotent across two rapid invocations.

### D4 — Month-index trade record is read-modify-write (lost update) 🟠 High  [S1, O5]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/trades/[action].ts` — `get<string[]>(monthKey)` then `set(monthKey, [...monthList, id])` at ~499–501 (spread), ~721–723 (stock/option submit), ~1395–1397 and ~1481–1483 (import). The open index correctly uses `rpush`/`lrem`; the *month* index does not. `kv-keys.ts` even warns against RMW on `trades:index:open` — same hazard, not applied here. The grade-cron's auto-import (`cron/[job].ts`) appends to the same month key concurrently.
- **Scenario:** A user submit races the 5-min auto-import (or two tabs) on the same `trades:index:YYYY-MM` key. Both read before either writes; one appended id is overwritten.
- **Cost:** The `trade:T-…` record survives but vanishes from `/trades`, `/calendar`, `/performance`, and the tendency cron — its P&L silently drops out of every rollup and it's never AI-graded. On a live trade, realized P&L never recorded.
- **Fix direction:** Make the month index a Redis list written with `rpush(tradesIndexMonthKey(month), id)` and read with `lrange` (mirror the open index; the cron already uses `lrange` on the assignment month push). Migrate readers; one-time backfill of existing JSON-array month keys into lists.
- **Test direction:** vitest with the KV mock: two concurrent appends to the same month key both survive (list semantics); readers return both ids.

### D5 — Closing fills imported as STO opens → phantom trades 🟠 High  [S4]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/trades/[action].ts:1412–1419` — `if (sideRaw === 'sell_short' || sideRaw === 'sell') side = 'STO'`. Alpaca uses `side:'sell'` for **both** short-open (STO) and buy-to-close is `buy`… but a sell-to-close (STC) of a long and a sell-to-open both surface as `sell`; more importantly a BTC close of a short carries `side:'buy'` and is treated as a BTO **open**. Net: closing fills are misclassified as opens. Dedup (`orderIdAlreadyImported`) keys on the *open* order id, so the close (different order id) passes.
- **Scenario:** The 5-min auto-import window slides over a closing fill; it's imported as a fresh "open," added to `trades:index:open`, consumes a trade id, and on its first cron pass `detectClose` queries a position that's already gone → spurious Path-3 external-close with fabricated P&L.
- **Cost:** Phantom trades inflate open-count and corrupt `/trades` P&L history (bookkeeping integrity on the active book).
- **Fix direction:** Use Alpaca's `position_effect` (`opening`/`closing`, present on FILL activities) to import **opening** fills only; or skip any fill whose timestamp is after an existing trade record for the same OCC. Add `position_effect` to the activity type.
- **Test direction:** vitest: an activity stream containing an STO open followed by its BTC close imports exactly one (opening) trade; a lone closing fill imports nothing.

### D6 — Spread `syncFillData` skips the modify-chain walk → modified spread stuck unfilled 🟠 High  [S5]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/cron/[job].ts:355–386` — the spread branch deliberately does not walk `replaces`/`replaced_by` ("paper mleg orders submit as one unit…"). But a user can PATCH a spread's limit on Alpaca's web UI; the trade's `alpaca_order_id` then points at the now-`replaced` order. `syncFillData` fetches it, sees `status:'replaced'` (not filled), returns; the trade stays `filled_at: null` forever and `detectClose` Path 0 leaves it open.
- **Scenario:** Live (or paper) spread modified post-submit on Alpaca's UI; it fills, but the dashboard never updates.
- **Cost:** A real spread position is invisible to the dashboard — realized P&L never recorded, grading never fires, open-index entry never cleaned. Worst on live.
- **Fix direction:** For spread orders, also walk `replaced_by` to the terminal order before reading status (mirror the single-leg path).
- **Test direction:** vitest: a spread order with `status:'replaced'` + `replaced_by` → `syncFillData` follows to the filled successor and writes `filled_at`/`net_credit`.

### D7 — `syncFillData` re-runs every tick; a throttle then blocks close detection 🟠 High  [S2]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/cron/[job].ts:346` — early-exit `if (trade.filled_at && (trade.modify_history?.length ?? 0) > 0) return trade`. For the common filled/never-modified trade, `modify_history` is `[]` (length 0), so the guard never short-circuits → an Alpaca order fetch every 5-min tick for every open trade for its whole life. If that call is rate-limited/errors, `syncFillData` returns early and **`detectClose` never runs**.
- **Scenario:** 10+ open option trades across 7 accounts → 10–70 pointless Alpaca calls/tick; under throttling, close detection is blocked for all of them.
- **Cost:** On live, a bot-closed STO never gets realized P&L recorded; trades stuck "open" indefinitely; wasted rate budget that can cascade into D13.
- **Fix direction:** Write a `fill_confirmed: true` sentinel the first time a fill is confirmed and early-return on it (the code comment already proposes `modify_history_checked`). Keep walking the modify chain only while unconfirmed.
- **Test direction:** vitest: a `fill_confirmed` trade is skipped by `syncFillData` (no Alpaca call); an unconfirmed filled trade is fetched once then marked confirmed.

### D13 — `findClosingFill` fetches only one page (100 activities) 🟡 Medium  [S12]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/cron/[job].ts:833` — `/v2/account/activities?activity_types=FILL&after=<1d before fill>&page_size=100`, single request. On the wheel accounts (10 symbols) 100 fills in a 1-day window is reachable; if the matching close is the 101st, `findClosingFill` returns null and Path 3 leaves the trade open.
- **Scenario:** Busy account; the closing fill falls past the first 100 → never matched.
- **Cost:** Trade stuck open, realized P&L never recorded, grading never fires (permanent when it occurs).
- **Fix direction:** Paginate the activities walk (`page_token`/`after` cursor) until the contract's closing fill is found or the window is exhausted; bound the loop.
- **Test direction:** vitest: closing fill on page 2 is found after pagination; absent fill exhausts and returns null without infinite loop.

### D11 — Past-expiry STO mis-booking: assigned shares invisible / null-fill P&L=0 🟡 Medium  [O8, S11]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/cron/[job].ts:575–591` (Path 2 expiry booking) with backstop (`SETTLEMENT_BACKSTOP_MS`, ~28/583); assignment spawn only fires on `closed_by === 'assigned'` (~170–175). (a) When `resolveOptionSettlement` returns null past the 3-day backstop, the contract is booked `closed_by:'expired'` with full premium kept (a win) — if it was actually **assigned**, the spawn never fires and the 100 delivered shares get no trade record (invisible on exposure/P&L). (b) `realized_pnl: (trade.filled_avg_price ?? 0) * 100 * qty` ⇒ if `filled_avg_price` is null, P&L books as **0** (breakeven) instead of the real premium.
- **Scenario:** Live short put expires ITM and is assigned, but OPASN activity doesn't post within the backstop → booked as an expired-worthless win; the real long-stock position is untracked.
- **Cost:** Untracked real equity position on live; wrong win/loss + win-rate + grader context.
- **Fix direction:** When settlement is unconfirmed past the backstop, cross-check `/v2/positions/{underlying}` for newly delivered shares before booking "expired"; prefer leaving the trade open / flagging for review over assuming worthless. Guard the null `filled_avg_price` case (don't book P&L=0 silently).
- **Test direction:** vitest: unconfirmed past-backstop STO with shares present in positions → not booked expired (or booked assigned + spawn); null `filled_avg_price` does not silently produce P&L 0.

### D14 — Spread-close P&L uses pre-fill mid when `syncFillData` hasn't run 🟢 Low  [S7]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/cron/[job].ts:751–753` — `realized = (trade.spread.net_credit − netDebit) × 100 × qty`. `net_credit` is the decision-time mid until `syncFillData` overwrites it with the actual fill; if `detectExternalSpreadClose` fires first, realized is off the target mid, not the entry fill.
- **Scenario:** A spread closes externally before the next sync tick updates its entry credit.
- **Cost:** Small realized-P&L inaccuracy on `/trades` (not an order-placement bug).
- **Fix direction:** Ensure `spread.net_credit` reflects the actual open fill (force a sync) before computing realized close P&L, or derive entry credit from the open fill activity.
- **Test direction:** vitest: close detection on a not-yet-synced spread uses the actual fill credit, not the target mid.

### D3 — Backup-code consumption is read-modify-write (single-use racy) 🟠 High  [O4, S9]
- **Status:** ⬜ TODO
- **Location:** `dashboard/api/_lib/backup-codes.ts:30–40` — `get<string[]>(USED_KEY)` → `includes` check → `push` → `set`. Two concurrent logins with the same code both read it as unused, both succeed.
- **Scenario:** Same backup code submitted twice within a tick (made trivial by D8's defeated rate-limit) → consumed twice → two authenticated sessions.
- **Cost:** Single-use guarantee broken → an old/leaked backup code authenticates more than once → order-placement access.
- **Fix direction:** Atomic mark-consumed: `SADD auth:used-backup-codes <hash>` and treat add-count 0 as "already used" (or per-code `SETNX`), replacing the get-then-set on a JSON array.
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
| D2 | No idempotency key on submit (double-place) | 1 | ⬜ TODO |
| D4 | Month-index read-modify-write lost update | 2 | ⬜ TODO |
| D5 | Closing fills imported as opens (phantom trades) | 2 | ⬜ TODO |
| D6 | Spread `syncFillData` skips modify-chain | 2 | ⬜ TODO |
| D7 | `syncFillData` every-tick + blocks close detection | 2 | ⬜ TODO |
| D13 | `findClosingFill` single-page cap | 2 | ⬜ TODO |
| D11 | Past-expiry STO mis-booking (assigned invisible) | 2 | ⬜ TODO |
| D14 | Spread-close pre-fill-mid P&L | 2 | ⬜ TODO |
| D3 | Backup-code consumption race | 3 | ⬜ TODO |
| D8 | `X-Forwarded-For` rate-limit bypass | 3 | ⬜ TODO |
| D10 | No server-side session expiry | 3 | ⬜ TODO |
| D9 | Short-call exposure understates → TOTP skip | 4 | ⬜ TODO |
| D12 | Debit-spread close P&L mis-signed | 4 | ⬜ TODO |
| D15 | Import cursor date-truncation duplicates | 4 | ⬜ TODO |
