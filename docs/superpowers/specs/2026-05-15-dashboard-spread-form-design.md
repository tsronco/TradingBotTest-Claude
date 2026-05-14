# Dashboard Spread Order Form — Design

> **Phase 4 of the spread support track.** Phase 1 (detection foundation), Phase 2 (management on manual paper), and Phase 3 (daily summary visibility) all shipped on 2026-05-14. This phase adds the dashboard UI for *opening* put credit spreads — closing remains bot-driven.

**Status:** Design (not yet planned).

## Goal

Add a dashboard order form for opening put credit spreads on the manual paper account so Tim doesn't have to use Alpaca's web UI for 2-leg orders. Submitted spreads land on Alpaca; bot adopts them on the next cron via existing Phase 1 detection; bot manages them via existing Phase 2 logic. Same trade-record / AI-grading / calibration flow as single-leg trades.

## Non-goals (explicitly deferred)

- **Call credit spreads.** Put credit only. Adding call credit is a quick follow-up.
- **Debit spreads.** Out of scope; bot doesn't manage them.
- **User-initiated close from dashboard.** Close is bot-driven (50% profit / stop / DTE). Manual override stays as Alpaca web UI for now.
- **Edit or roll a spread mid-trade.** No "modify" button. Close manually + open new.
- **Live account spread orders.** Live is greyed out in the account dropdown with a tooltip.
- **Multi-spread submits.** One spread per submit; multiple = multiple submits.
- **Spread-value-over-time chart.** Existing TradeDetail price chart gets both strike markers; the spread-value time series is a future enhancement.
- **Teach `rule-check.ts` to consider `spread_active` overlap when evaluating bot-wheel overlap on manual single-leg orders.** Separate plan.

## Architecture

A put credit spread is a 2-leg Alpaca order (`order_class: mleg`). Three layers update:

1. **Form UI** — new `SpreadOrderForm.tsx`; `OrderNew.tsx` gains a third URL-param branch (`?spread=put_credit&symbol=AAL`).
2. **Submit API** — `/api/trades/submit` detects spread payload shape and builds an mleg Alpaca order. Single-leg path unchanged.
3. **Trade record schema** — `Trade` type gains an optional `spread?: SpreadDetails` block. Spread trades populate it instead of (or alongside) the single-leg OCC fields.

Bot Phase 1 and Phase 2 are **unchanged**. The dashboard creates the position; the bot picks it up via existing `_detect_spread_pairs` on the next discovery cycle. Clean separation.

## File structure

### Frontend (`dashboard/src/`)

| File | Status | Responsibility |
|---|---|---|
| `routes/OrderNew.tsx` | Modify | Add third URL-param branch for `?spread=put_credit`. Renders `SpreadOrderForm`. |
| `routes/Lookup.tsx` | Modify | Add a "Build Put Credit Spread" button next to the existing action buttons. Visible on every symbol that returns at least one option expiration from `/api/alpaca/contracts`; hidden when no options chain exists. ~20 lines. |
| `components/order/SpreadOrderForm.tsx` | Create | Form: expiration dropdown → chain fetch → short strike + long strike dropdowns → live net credit / max loss preview → grade + reasoning fields → Review button. ~250 lines. |
| `components/order/ConfirmModal.tsx` | Modify | Spread-aware copy showing both legs + net credit + max loss. ~30 lines of conditional rendering. |
| `routes/Trades.tsx` | Modify | Detect `trade.spread != null` and render one row showing `AAL put credit $12.50/$11.50`. ~20 lines. |
| `routes/TradeDetail.tsx` | Modify | Spread branch in the metadata block + both strike markers on the lightweight-charts chart. ~80 lines. |
| `routes/Rules.tsx` | Modify | New rule type display: `max_risk_per_spread` with a dollar input. Seed the rule with a default cap of $500 (warn level) on first dashboard load if the rule doesn't already exist. ~50 lines. |
| `lib/trade-types.ts` | Modify | Add `SpreadDetails` interface (mirrors `_empty_spread_state` shape from `wheel_strategy.py`). Add optional `spread?: SpreadDetails` to `Trade`. ~25 lines. |
| `lib/rule-check.ts` | Modify | New case: `max_risk_per_spread` → warn/block if `(max_loss × 100 × qty) > limit`. ~20 lines. |

### Backend (`dashboard/api/`)

| File | Status | Responsibility |
|---|---|---|
| `trades/[action].ts` | Modify | `submit` handler: detect `spread` field on payload, build mleg Alpaca order, write spread-shaped trade record. `preview` handler: branch on payload to call spread-specific exposure calc. ~150 lines added. |
| `_lib/trade-types.ts` | Modify | Server-side mirror of frontend `SpreadDetails` + `Trade.spread` field. |
| `_lib/exposure.ts` | Modify | For spread payloads, exposure = `(width − credit) × 100 × qty`. Branch on payload shape. ~15 lines. |
| `_lib/rule-check.ts` | Modify | Server-side `max_risk_per_spread` rule check, identical shape to frontend. ~15 lines. |
| `_lib/grading.ts` | Modify (light) | Sonnet 4.6 prompt addition for spread context (both strikes + net credit, not single strike). The hindsight grading on close uses both leg mids to compute close P&L. ~30 lines. |
| `cron/[job].ts` | Modify (light) | `syncFillData` walks both leg fills from Alpaca's mleg order response and populates `trade.spread.short_fill_price` + `long_fill_price`. ~40 lines. |

### No-touch (verify only)
- `alpaca/[endpoint].ts`'s generic `/orders` POST proxies the body through unchanged; the new `legs` array passes through correctly. Add a smoke-test only.

## `SpreadDetails` schema

Both frontend and backend `trade-types.ts` declare:

```ts
interface SpreadDetails {
  spread_type: 'put_credit';  // call_credit/debit added later
  short_leg: {
    occ: string;          // e.g. "AAL260529P00012500"
    strike: number;       // 12.50
    entry_premium: number | null;  // null until fill
    fill_price: number | null;     // populated by syncFillData on fill
    qty: number;          // contracts (matches outer trade.qty)
  };
  long_leg: {
    occ: string;
    strike: number;
    entry_premium: number | null;
    fill_price: number | null;
    qty: number;
  };
  expiration: string;     // ISO date string "2026-05-29"
  width: number;          // 1.0
  net_credit: number;     // 0.25 — target from order; updated to actual on fill
  max_loss: number;       // 0.75 = width - net_credit
}
```

`Trade.spread` is optional. When set, the trade represents a spread; the existing single-leg OCC/strike fields on `Trade` stay null (or get short-leg duplicate values for convenience). Renderers check `trade.spread != null` to branch.

## Form UX flow

1. **Entry point.** User on `/lookup/{SYMBOL}` clicks the **"Build Put Credit Spread"** button next to the existing action buttons. The button is **required and visible on every symbol** whose `/api/alpaca/contracts?symbol={SYMBOL}` response returns at least one expiration (i.e. the underlying has tradeable options). Hidden when no options chain exists for the symbol (cash-only stocks like LMT-equivalents). Redirects to `/order/new?spread=put_credit&symbol={SYMBOL}`.

2. **OrderNew** sees `?spread` URL param → renders `SpreadOrderForm`.

3. **SpreadOrderForm** renders:
   - Heading: "Open AAL put credit spread"
   - Account dropdown: `manual_paper` (selected) + `live` (disabled, tooltip: "spread_management: False on live — enable in a future plan")
   - Expiration dropdown — fetched from `/api/alpaca/contracts?symbol=AAL&type=put`
   - On expiration select → fetch chain → populate strike dropdowns
   - **Short strike** dropdown — put strikes from chain
   - **Long strike** dropdown — put strikes from chain, filtered to strikes < short_strike
   - **Quantity** input (default 1)
   - **Live net credit / max loss** preview — pulled from leg mids when both strikes selected
   - **Grade** dropdown (A–F) + **Reasoning** textarea (both required)
   - **Review** button → calls `/api/trades/preview`

4. **`/api/trades/preview`** returns `{exposure, requires_totp, rule_warnings[], draft}`.

5. **ConfirmModal** shows:
   - "Open AAL put credit spread $12.50/$11.50, qty 1"
   - "Net credit: $0.25 ($25.00)"
   - "Max loss: $0.75 ($75.00)"
   - "Collateral: $75.00"
   - Any rule warnings displayed prominently
   - Confirm button → calls `/api/trades/submit`
   - If `requires_totp`, TOTP input shown (same as single-leg flow)

6. **`/api/trades/submit`**:
   - Generates trade ID `T-2026-05-15-NNN`
   - Builds mleg payload:
     ```ts
     {
       order_class: "mleg",
       qty: String(qty),
       type: "limit",
       limit_price: String(-target_credit),  // negative = credit
       time_in_force: "day",
       legs: [
         {symbol: short_occ, side: "sell", ratio_qty: "1", position_intent: "sell_to_open"},
         {symbol: long_occ,  side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"},
       ],
     }
     ```
   - POSTs to Alpaca trading endpoint via the existing `alpacaTradeMutation()` helper
   - Writes trade record to KV with `spread` block populated, `filled_at: null`
   - Adds to `trades:index:open` and `trades:index:YYYY-MM`
   - Returns `{trade_id, alpaca_order_id}`

7. **`grade-open-trades` cron** runs every 5 min; `syncFillData` polls Alpaca for the mleg order, walks both legs, populates `trade.spread.{short,long}_leg.fill_price` when both are filled. Sets `trade.filled_at` + computes actual `trade.spread.net_credit` from fills.

## Close flow (no dashboard change needed)

Bot Phase 2 `handle_spread` closes the spread autonomously (50% profit, 50% max loss, DTE ≤ 2 with short ITM). On close:
- Bot's existing dashboard-push step writes `closed_at`, `closed_avg_price`, `closed_by: "bot:reason"` to the trade record via `/api/bot-state`
- Next `grade-open-trades` tick sees the close and runs AI hindsight grading
- Calibration delta renders on `/trade/:id` exactly like single-leg trades

## AI grading prompt addition

Current single-leg prompt (paraphrase): *"You're grading a paper trade. Symbol: AAL. Side: sell put. Strike: 12.50. Premium: $0.37. Entry context: \[...]. Hindsight context: \[...]. Grade A-F."*

Spread prompt addition (new branch on `trade.spread != null`): *"You're grading a paper put credit spread trade. Underlying: AAL. Short strike: $12.50. Long strike: $11.50. Net credit: $0.25. Max loss: $0.75. Spot at entry: $X. DTE at entry: 15. Entry context: \[user grade + reasoning]. Hindsight context: \[close P&L, close reason]. Grade the entry decision A-F."*

Both flows share the same calibration math.

## Rule check: `max_risk_per_spread`

New rule type alongside existing ones in `rules:list` KV. Shape:

```ts
{
  id: 'rule_uuid',
  type: 'max_risk_per_spread',
  enabled: true,
  level: 'warn' | 'block',
  config: { max_dollars: 500 },  // user-configurable on /rules/edit
}
```

`rule-check.ts` evaluation: when a spread submit comes in, compute `risk_dollars = max_loss × 100 × qty`. If `risk_dollars > rule.config.max_dollars`:
- `level: 'warn'` → preview returns the warning in `rule_warnings`; user can proceed
- `level: 'block'` → preview returns it as a blocker; submit refuses unless user types an override reason

**Default seeding:** On first dashboard load (or when no `max_risk_per_spread` rule exists in `rules:list`), the system creates one with `max_dollars: 500`, `enabled: true`, `level: 'warn'`. Sensible cap for the current paper-only era. The user can edit or disable it on `/rules` whenever.

UI on `/rules` adds a new card displaying current rules of this type. `/rules/edit` flow adds a small wizard: pick "max risk per spread" → enter dollar cap → save.

## Testing approach

### Frontend (vitest)

- `SpreadOrderForm` renders both strike dropdowns from a mock chain response
- Long-strike dropdown filters to strikes < selected short strike
- Submitting calls `/api/trades/preview` with the spread payload shape
- After preview returns, ConfirmModal renders both legs + net credit + max loss
- `Trades.tsx` renders a spread row (`AAL put credit $12.50/$11.50`) when `trade.spread` is set
- `TradeDetail.tsx` renders both leg metadata + both strike markers when spread mode
- `Rules.tsx` displays the new `max_risk_per_spread` card with the configured cap

### Backend (vitest)

- `/api/trades/submit` with a spread payload builds correct mleg Alpaca order
- `/api/trades/preview` computes spread exposure as `(width - credit) × 100 × qty`
- `rule-check.ts` `max_risk_per_spread` warns at $50 cap when a $75 max-loss spread is submitted; blocks at the same cap when level=block
- `syncFillData` walks both leg fills from a mock mleg Alpaca response and populates `trade.spread.{short,long}_leg.fill_price`
- AI grading prompt branches correctly for `trade.spread != null` paths (verify prompt text, not LLM output)

### Smoke

After merge, open a second real spread on manual paper (e.g. F $11/$10, similar small-account scale). Confirm:
- Form opens, fills both strike dropdowns from real Alpaca chain
- Submit lands an mleg order on Alpaca
- AAL spread (already open) still shows correctly in `/trades`
- New spread appears as one row; clicking it shows both legs on TradeDetail
- Bot's next cycle adopts the new spread (`Wheel: adopted spread F` embed in `#manual-trades`)
- Both spreads visible in tomorrow's daily summary

Target: ~15-20 new vitest tests. No new pytest needed (bot side unchanged).

## Risks

- **Alpaca paper mleg order flakiness.** Saw this opening AAL — multiple fill attempts at different limit prices. Form's submit must NOT mark `filled_at` optimistically. `syncFillData` populates fill state on subsequent cron ticks; until then the trade shows as "submitted, not filled" on `/trades`.
- **Sonnet 4.6 prompt drift.** Adding spread-context to the prompt risks regressions on single-leg grading. The branch must be strictly `if trade.spread != null` so single-leg trades hit the exact same prompt path they do today.
- **Trade index bloat.** Each spread = one trade record. Volume should stay low (manual paper, a few spreads per month). No new index needed.
- **Vercel function count.** Currently 10 of 12 Hobby cap used. This plan adds zero new functions (all changes inside existing `trades/[action].ts`, `cron/[job].ts`, `_lib/`). Confirmed cap not breached.

## Out-of-scope deferrals (already mentioned, listed for self-review)

If any implementer is tempted by these mid-plan, STOP and report `DONE_WITH_CONCERNS`:

- Call credit / debit spreads on the form
- User-initiated close from dashboard
- Modify / roll spread mid-trade
- Live account spread submits (greyed out only)
- Multi-spread submits
- Spread-value-over-time chart
- `rule-check.ts` spread-active overlap awareness

## Open questions

None. All design decisions confirmed in brainstorming 2026-05-15:

1. Scope: put credit only — confirmed
2. Placement: OrderNew third mode — confirmed
3. Strike picker: two dropdowns from one chain — confirmed
4. Account targeting: manual + live (greyed) — confirmed
5. AI grading: same A-F + reasoning + prompt tweak — confirmed
6. Risk checks: reuse rule-check + new `max_risk_per_spread` rule (default $500 warn) — confirmed
7. Trade record: one record per spread, special-cased rendering — confirmed
8. Lookup-page entry button: required, visible on every optionable symbol — confirmed
