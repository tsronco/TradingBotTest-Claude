# Trade-detail break-even — design

**Date:** 2026-06-23
**Status:** approved (design), pending implementation
**Surface:** dashboard (client-only; no API or schema change)

## Problem

The break-even price of a position is only visible while *placing* an order (the
`PayoffChart` in the order form shows it). Once the order is placed, the trade
detail screen (`/trade/:id`) never shows it again. The user wants to see, after
the fact, what the break-even was for the position **as taken** — the real
break-even of the position they actually entered.

## Goals

- Show a break-even **readout** on the trade detail screen for every trade.
- Draw the break-even as a **horizontal line on the trade's price chart**, so it's
  obvious at a glance whether price sits above or below it.
- Use the **actual fill-based** break-even (the true break-even of the entered
  position), not the pre-fill limit-price estimate.
- Work **retroactively** on every trade already in the system.

## Non-goals (YAGNI)

- No "distance from current price to break-even" readout or above/below coloring.
- No schema change, no snapshot-at-entry field, no server-side computation.
- No auto-roll / what-if / scenario tooling.

## Approach

**Recompute on the client from the stored trade record**, reusing the existing
payoff engine (`src/lib/payoff.ts` → `buildPayoff`). Because break-even is a pure
function of a position's legs (strikes, entry premium, side) and all of those are
already persisted on the `Trade` record, no new data needs to be stored. Reusing
`buildPayoff` guarantees the post-trade number matches what the order form showed
at entry (single source of truth).

Rejected alternatives:
- **Snapshot at entry into the schema** — requires a schema change and does *not*
  work on existing trades (blank until re-saved).
- **Server-side computation in `/api/trades/get`** — duplicates the payoff engine
  on the server for no benefit; the chart needs the value client-side regardless.

## Components

### 1. Pure helper — `src/lib/trade-breakeven.ts` (new)

```
tradeToLegs(trade: Trade): Leg[]
tradeBreakevens(trade: Trade): number[]
```

`tradeToLegs` maps a `Trade` to payoff `Leg[]` using **fill prices**:

| asset_class | leg(s) | premium / entry source | break-even |
|---|---|---|---|
| `stock` | one `stock` leg, `dir` from `side` (buy→long) | `filled_avg_price` | = cost basis |
| `option` | one `option` leg, `dir` from `side` (BTO/BTC→long, STO/STC→short), `type` = `contract_type` | `filled_avg_price` | strike ± premium |
| `spread` | two `option` legs from `trade.spread` (short_leg `dir:'short'`, long_leg `dir:'long'`), `type` = put for put_*, call for call_* | each leg's `fill_price` | from `buildPayoff` |

**Fallbacks (in order):**
- single-leg premium/entry: `filled_avg_price` → `limit_price`
- spread leg premium: `fill_price` → `entry_premium`; if a leg lacks both, fall
  back to deriving net from the stored `net_credit` / `net_debit`.
- if nothing usable (e.g. canceled, never filled, no prices): return `[]`.

`tradeBreakevens` calls `buildPayoff(tradeToLegs(trade), refPrice).breakevens`.
`refPrice` is chosen internally only to bracket the break-even search window (it
does not affect the break-even values): the entry price for a stock leg, a strike
for option/spread legs.

### 2. Readout — `src/components/trade/TradeHeader.tsx`

Add a `break-even $X` line under the existing trade summary line, shown for all
trades. Multiple break-evens (rare; e.g. a future straddle) join with ` / `.
Empty result renders `—`.

### 3. Chart line — `src/components/trade/TradeChart.tsx`

For each break-even value, add a dashed horizontal `series.createPriceLine` —
the same mechanism the spread short/long strikes already use — in a distinct
color (cyan), `axisLabelVisible: true`, titled `BE $X.XX`. Applies to all asset
classes (today the chart only draws lines for spreads).

## Edge cases

- **Unfilled / open limit order:** uses `limit_price` fallback so a resting order
  still shows its intended break-even.
- **Canceled, never filled:** no usable price → `[]` → readout shows `—`, no line.
- **Stock:** break-even = entry/cost basis (a single value). Shown per the user's
  choice to include stock for consistency.
- **Spread with one missing `fill_price`:** falls back to `entry_premium` for that
  leg, then to stored net credit/debit.

## Testing

Unit tests on the pure helper (`tests/lib/trade-breakeven.test.ts`):
- long stock → BE = entry
- long call → strike + premium; long put / short put → strike − premium
- put-credit spread → short strike − net credit
- call-credit spread → short strike + net credit
- unfilled single-leg → uses `limit_price` fallback
- canceled / no price data → `[]`

Presentational changes (readout, chart line) are covered by the existing
component test patterns where practical; the math lives in the tested helper.

## Files touched

- `dashboard/src/lib/trade-breakeven.ts` (new)
- `dashboard/src/components/trade/TradeHeader.tsx`
- `dashboard/src/components/trade/TradeChart.tsx`
- `dashboard/tests/lib/trade-breakeven.test.ts` (new)
