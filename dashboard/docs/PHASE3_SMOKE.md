# Phase 3 End-to-End Smoke Test

Run after deploying Phase 3 to production. ~10–15 minutes during market hours.

## Prerequisites

- Logged into the dashboard with a live session cookie
- `BOT_PUSH_TOKEN`, `CRON_TOKEN`, `ANTHROPIC_API_KEY` all set on Vercel
- `dashboard/.vercel/project.json` exists (or `npx vercel link --yes --project tradingbot-dashboard` was run before deploy)

## 1. Bot rules pipe (M1)

- [ ] Manually dispatch each monitor workflow:
  ```bash
  gh workflow run tsla-monitor.yml
  gh workflow run tsla-monitor-aggressive.yml
  gh workflow run tsla-monitor-manual.yml
  ```
- [ ] After each completes, navigate to `/rules` → **Bot rules** section.
- [ ] Verify all three columns (Conservative · Aggressive · Manual) populate with wheel + strategy + (cons only) congress data, with a recent `pushed_at` timestamp.
- [ ] Manual column should show the `auto_discover_symbols` and `wheel_skip_new_puts` flags.

## 2. Manual rule + active rule-checker (M2 + M3)

- [ ] On `/rules`, click **[+ add rule]**.
- [ ] Title: `TEST: no F`. Severity: `block`. Triggers: add `symbol_in: F`. Body: `smoke test rule — block F`.
- [ ] Save → returns to `/rules` → new card appears under **My rules** with the red BLOCK badge.
- [ ] Navigate to `/order/new?symbol=F&type=stock`. Pick `conservative_paper`, qty 10.
- [ ] Click `[Review]`. The confirm modal opens with a red banner listing the violation.
- [ ] Submit button reads `[override required]` and is disabled.
- [ ] Type a 25-char reason in the override textarea. Submit button enables and reads `[override & place*]`.
- [ ] Click submit. Then immediately cancel the order from `/orders`.
- [ ] Open `/trade/<id>` for the canceled order. Verify the trade record's `rule_warnings_at_entry` includes the violation with the typed `override_reason`.
- [ ] Delete the test rule from `/rules`.

## 3. Tendency cron (M4)

- [ ] Trigger the cron manually (instead of waiting for Sunday):
  ```bash
  curl -X POST -H "Authorization: Bearer $CRON_TOKEN" \
    https://tradingbot-dashboard-blue.vercel.app/api/cron/detect-tendencies?job=detect-tendencies
  ```
- [ ] Response shape: `{ findings_count: N, proposals_appended: M, demotes_appended: K, llm_calls: X }`.
- [ ] Likely 0 findings until you have ≥3 closed losing trades on a single symbol — that's expected on first deploy.
- [ ] If findings exist: navigate to `/rules` → **Tendencies** + **Proposals** sections. Verify cards render. Try **[Add to my rules]** on a proposal — confirm it lands in **My rules** with `from tendency` badge.

## 4. STO assignment auto-spawn (M5)

This requires actual market activity, so test with a paper STO put that's likely to assign:

- [ ] During market hours, place a paper STO put close to ATM on a cheap stock with imminent expiration. E.g., `F $13P` expiring in 1–2 days at the bid.
- [ ] Wait for fill, then for assignment (or simulate by using the Alpaca dashboard to manually mark assigned).
- [ ] After the next grade-cron tick (every 5 min during market hours), navigate to `/trade/<parent-put-id>`.
- [ ] Verify a green "↓ Assignment spawned T-..." link appears above the trade header.
- [ ] Click → child trade detail. Verify "↑ Assigned from T-..." link, plus `(grades inherited from parent)` caption.
- [ ] Verify child has `qty: 100`, `entry_price = strike`, inherited `entry_grade` and tags.

## 5. /watchlist + /calendar + /performance (M6)

- [ ] `/watchlist` — add a symbol via the input. Verify quote + day % + 30d sparkline render. Click symbol → `/lookup/X`. Remove and re-add.
- [ ] `/calendar` — current month grid renders. Days with closed trades show colored P&L badges. Click a day with trades → side drawer opens listing them.
- [ ] `/calendar` — change account filter to one with no trades for the month → grid shows all-empty cells (no errors).
- [ ] `/performance` — all 6 panels render. Equity curve overlays cons/agg/manual (where data exists). Drawdown chart shows red running drawdown line. Calibration scatter shows your-vs-AI dots; mean delta caption matches direction. Win-rate-by-tag bars present. P&L by symbol table sorts by clicking headers. Time heatmap shows Mon-Fri × 9-15 ET grid.
- [ ] Switch date range to `1W` → all 6 panels refetch and re-render.

## 6. Live-account guard (M7)

- [ ] curl `/api/trades/submit` directly with an `account: 'live'` body:
  ```bash
  curl -X POST \
    -H "Cookie: $DASHBOARD_SESSION" \
    -H "Content-Type: application/json" \
    https://tradingbot-dashboard-blue.vercel.app/api/trades/submit?action=submit \
    -d '{"account":"live","asset_class":"stock","symbol":"F","side":"buy","qty":1,"order_type":"market","tif":"day","entry_grade":"B","entry_reasoning":"x","rule_violations":[]}'
  ```
- [ ] Expected: `403 {"error":"live_trading_disabled"}`.

## If all six sections pass

Phase 3 is live and validated. Update CLAUDE.md → **Dashboard subproject** → "Phase 3 deliverable" with the validation date and any quirks discovered during the test.
