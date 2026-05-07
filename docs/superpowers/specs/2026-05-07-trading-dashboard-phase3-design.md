# Trading Dashboard — Phase 3 Design (Rules / Playbook / Coaching)

**Date:** 2026-05-07
**Status:** approved (brainstorm), ready for writing-plans
**Predecessors:** [Phase 1 plan](../plans/2026-05-02-trading-dashboard-phase1.md) · [Phase 2 plan](../plans/2026-05-03-trading-dashboard-phase2.md) · [parent spec](2026-05-02-trading-dashboard-design.md) · [handoff 2026-05-03](../HANDOFF-2026-05-03.md)

## Goal

Phase 3 ships the rules / playbook / coaching layer of the trading dashboard. After it lands, Tim can:

- Pull up `/rules` in 30 seconds before placing a trade and see his bot rules + manual rules + playbook patterns + tendencies + cheatsheets + goals in one place.
- Get warned (or blocked + override-with-reasoning) on order placement when a trade violates a rule.
- Have the system watch his closed trades on a Sunday cron, surface behavioral patterns, and propose new rules he approves with one click — and *demote* existing block-severity rules he keeps profitably overriding.
- See P&L on a calendar, performance analytics, and a watchlist as native pages instead of inferring them from `/trades` and KV inspection.
- Have STO put assignments auto-spawn linked follow-on stock trades so the wheel completion loop is tracked end-to-end.

It also closes the four known follow-ups from the Phase 2 final review.

## Scope

Single plan, shipped as one PR. All 5 pages from the parent spec's Phase 3 section, plus active rule-checker, plus tendency detection cron, plus the 4 follow-ups.

**In scope:**
- `/rules`, `/rules/edit`, `/watchlist`, `/calendar`, `/performance` pages
- Active rule-checker on order placement (replaces Phase 2 stub)
- Tendency detection cron with proposal inbox + rule-demotion loop
- STO assignment → auto-spawned follow-on stock trade
- Server-side `live` account 403 guard
- DST-aware option-expiration detection in grade-cron
- TS warning cleanup at `api/alpaca/[endpoint].ts:38`

**Out of scope (deferred to Phase 4):**
- Daily 4:15 PM coach's note cron + home-page card
- PWA setup (manifest, service worker, install prompt)
- Push notifications
- Final accessibility/perf audit
- Tendency detection v2 (LLM-driven matchers) — Phase 3 uses deterministic matchers only

## Architecture overview

```
┌─ Bot side (existing workflows) ────────────────────────────────────┐
│  Each monitor run appends one Python step that builds a rules     │
│  payload from config.MODES and POSTs to /api/bot-state with       │
│  bearer auth → KV key bot:rules. Refreshed ~every 10 min.         │
└────────────────────────────────────────────────────────────────────┘

┌─ Dashboard API additions ──────────────────────────────────────────┐
│  api/rules/[resource].ts        NEW — manual/patterns/cheatsheets/ │
│                                  goals CRUD; tendencies/proposals  │
│                                  read + approve/dismiss; bot read  │
│  api/trades/[action].ts         + check (replaces stub)            │
│                                  + calendar (month aggregations)   │
│                                  + performance (six panels)        │
│  api/cron/[job].ts              + detect-tendencies                │
│                                  grade-open-trades extended for    │
│                                  assignment detection + drain      │
│  api/bot-state.ts               + bot:rules in key whitelist       │
│                                                                    │
│  Total functions: 9 → 10 of 12 Hobby cap                           │
└────────────────────────────────────────────────────────────────────┘

┌─ Dashboard frontend additions ─────────────────────────────────────┐
│  src/routes/Rules.tsx           /rules — read-only 7-section view  │
│  src/routes/RulesEdit.tsx       /rules/edit?section=...            │
│  src/routes/Watchlist.tsx       /watchlist                         │
│  src/routes/Calendar.tsx        /calendar                          │
│  src/routes/Performance.tsx     /performance                       │
│  src/components/rules/*         section cards, trigger builder,    │
│                                  proposal cards                    │
│  src/components/calendar/*      month grid, day drawer             │
│  src/components/performance/*   six panels (curve, drawdown,       │
│                                  scatter, bars, table, heatmap)    │
│  src/components/order/*         RuleViolations banner; block-      │
│                                  override fields in confirm modal  │
└────────────────────────────────────────────────────────────────────┘

┌─ New cron-job.org schedule ────────────────────────────────────────┐
│  detect-tendencies   `0 22 * * 0`   Sunday 6 PM ET (during DST)    │
│                      → POST /api/cron/detect-tendencies?           │
│                              job=detect-tendencies                 │
│                      Bearer ${CRON_TOKEN}                          │
└────────────────────────────────────────────────────────────────────┘
```

## Data model

### KV key additions

| Key | Contents | Writer |
|---|---|---|
| `bot:rules` | `{ conservative: BotRulesPayload, aggressive: BotRulesPayload }` | bot push (each monitor run) |
| `rules:manual` | array of `ManualRule` | `/rules/edit` |
| `rules:patterns` | array of `Pattern` (existing shape from parent spec) | `/rules/edit` |
| `rules:cheatsheets` | array of `Cheatsheet` | `/rules/edit` |
| `rules:goals` | array of `Goal` | `/rules/edit` |
| `rules:tendencies` | array of `Tendency` (one per matcher, replaced on each cron run) | `detect-tendencies` cron |
| `rules:proposals` | array of `Proposal` (open + dismissed history) | `detect-tendencies` cron · approve/dismiss endpoints |
| `trades:index:assignments-pending` | atomic Redis list of `AssignmentEntry` | `grade-open-trades` cron |

### Type definitions

```ts
// dashboard/api/_lib/rules-types.ts (new)

interface BotRulesPayload {
  wheel: {
    symbols: string[];                // priority + fallback flattened
    priority_tier?: string[];         // aggressive only
    fallback_tier?: string[];         // aggressive only
    otm_pct: number;                  // 0.10 cons, 0.05 agg
    dte_min: number; dte_max: number;
    close_at_profit_pct: number;      // 0.50 cons, 0.60 agg
  };
  strategy: {
    underlying: string;               // 'TSLA'
    initial_qty: number;
    stop_loss_pct: number;
    trail_activate_pct: number;
    trail_floor_pct: number;
    ladders: { trigger_pct: number; qty: number }[];
  };
  congress?: {                        // conservative only
    sizing_tiers: { name: string; min_disclosure: number; max_alloc: number }[];
    politicians: { id: string; name: string }[];
  };
}

type Severity = 'block' | 'warn';

type Trigger =
  | { type: 'symbol_in'; symbols: string[] }
  | { type: 'symbol_not_in'; symbols: string[] }
  | { type: 'side'; value: 'buy' | 'sell' }
  | { type: 'asset_class'; value: 'stock' | 'option' }
  | { type: 'option_type'; value: 'put' | 'call' }
  | { type: 'option_dte_lt'; value: number }
  | { type: 'option_dte_gt'; value: number }
  | { type: 'open_position_count_gt'; value: number }
  | { type: 'earnings_within_days'; value: number }
  | { type: 'strike_below_cost_basis' }
  | { type: 'tag_present'; tag: string };

interface ManualRule {
  id: string;
  title: string;
  body: string;                       // markdown, plain English — read by AI grader
  severity: Severity;
  triggers: Trigger[];                // ALL must match for rule to fire
  source: 'manual' | 'tendency';      // 'tendency' if promoted from a proposal
  created_at: string;                 // ISO
  updated_at: string;
}

interface Pattern {                   // existing shape
  id: string;
  environment: string;
  variables: string[];
  legs: string[];
  rules: string[];
  win_rate?: number;
}

interface Cheatsheet { id: string; title: string; body: string; }
interface Goal { id: string; body: string; target?: string; due?: string; checked?: boolean; }

type MatcherName =
  | 'loss_concentration_by_symbol'
  | 'loss_concentration_by_side'
  | 'cc_below_cost_basis'
  | 'held_through_earnings'
  | 'override_loss_pattern'
  | 'over_grading_self';

interface Tendency {
  id: string;                         // matcher + key dimension hash
  matcher: MatcherName;
  finding: string;                    // plain-English from Sonnet
  evidence_trade_ids: string[];
  detected_at: string;
}

interface Proposal {
  id: string;
  matcher: MatcherName;
  proposed_rule: {
    title: string;
    body: string;
    severity: Severity;
    triggers: Trigger[];
  };
  reasoning: string;                  // why this rule, from Sonnet
  evidence_trade_ids: string[];
  status: 'open' | 'dismissed' | 'approved';
  proposed_at: string;
  resolved_at?: string;
  // For demote proposals only:
  demote_target_rule_id?: string;
}

interface AssignmentEntry {
  parent_trade_id: string;
  underlying: string;
  strike: number;
  qty: number;
  account: 'conservative' | 'aggressive';
  detected_at: string;
}
```

### Trade record extensions

```ts
// dashboard/api/_lib/trade-types.ts (extend existing)

interface RuleViolation {
  rule_id: string;
  rule_title: string;
  severity: Severity;
  override_reason?: string;           // required iff severity === 'block'
}

interface Trade {
  // ... existing fields
  parent_id?: string;                 // links assignment-spawned stock trade to its put
  source?: 'manual' | 'assignment';   // defaults to 'manual'
  rule_violations?: RuleViolation[];  // captured at submit time
  ai_grade_inherited?: boolean;       // true on assignment-spawned trades
}
```

## Component design

### Bot rules pipe

Each `tsla-monitor.yml` and `tsla-monitor-aggressive.yml` workflow appends a step after its existing bot scripts:

```yaml
- name: Push rules to dashboard
  if: always()
  run: python tools/push_rules_to_dashboard.py --mode ${{ matrix.mode || 'conservative' }}
  env:
    BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
    DASHBOARD_URL: https://tradingbot-dashboard-blue.vercel.app
```

`tools/push_rules_to_dashboard.py` (new, ~50 lines):
- Imports `config.MODES`
- Builds `BotRulesPayload` per the type above
- POSTs to `${DASHBOARD_URL}/api/bot-state` with `Authorization: Bearer $BOT_PUSH_TOKEN`, body `{ key: 'bot:rules', value: { [mode]: payload } }`
- The dashboard `bot-state.ts` handler does a *partial merge* on `bot:rules` (existing logic only does whole-key replace today — we'll extend it to merge for the rules key specifically) so cons + agg can each push independently without clobbering each other

`bot-state.ts` whitelist gets `bot:rules` added to `kv-keys.ts`.

### Rules API (`api/rules/[resource].ts`)

Catchall dispatched by `req.query.resource`:

| Resource | Methods | Behavior |
|---|---|---|
| `manual` | GET / POST / PATCH / DELETE | CRUD on `rules:manual` array; PATCH/DELETE by `id` in body |
| `patterns` | GET / POST / PATCH / DELETE | CRUD on `rules:patterns` |
| `cheatsheets` | GET / POST / PATCH / DELETE | CRUD on `rules:cheatsheets` |
| `goals` | GET / POST / PATCH / DELETE | CRUD on `rules:goals` |
| `tendencies` | GET | Read-only `rules:tendencies` |
| `proposals` | GET / POST | GET returns open + dismissed (last 30 days); POST `{action: 'approve'\|'dismiss'\|'edit-and-approve', proposal_id, edits?}` |
| `bot` | GET | Read-through to `bot:rules` |

All require `requireAuth(req, res)` from `api/_lib/auth-guard.ts`.

Approve flow: takes a proposal, builds a `ManualRule` from its `proposed_rule` (or merged with `edits` if `edit-and-approve`), pushes to `rules:manual`, marks proposal `status: 'approved'` with `resolved_at`, returns the new rule. For demote proposals (`demote_target_rule_id` set), instead patches the target rule's `severity` from `block` to `warn`.

### Rule-checker engine (`api/_lib/rule-check.ts`)

Replace the Phase 2 stub. Signature unchanged:

```ts
export async function checkOrder(
  draft: OrderDraft,
  ctx: { mode: 'conservative' | 'aggressive'; positions: Position[]; quote?: Quote }
): Promise<{ violations: RuleViolation[] }>;
```

Implementation:

1. Load `rules:manual` and `bot:rules` from KV in parallel.
2. For each manual rule, evaluate every trigger against `draft + ctx`:
   - `symbol_in` / `symbol_not_in` — straight match on `draft.symbol`
   - `side` / `asset_class` / `option_type` — straight match on draft fields
   - `option_dte_lt` / `option_dte_gt` — parse expiration from `draft.option_symbol`, compute days from now (DST-aware via `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' })`)
   - `open_position_count_gt` — count `ctx.positions` matching `draft.symbol`
   - `earnings_within_days` — call `fundamentals-fetch.ts` cached helper (already have it), check next earnings date
   - `strike_below_cost_basis` — for option draft, find matching stock position in `ctx.positions`, compare `draft.option_strike < position.avg_entry_price`
   - `tag_present` — match against `draft.tags`
3. Rule fires when all triggers true → push to violations array.
4. For bot rules, generate synthetic warn-severity violations on three checks:
   - Symbol not in `bot.wheel.symbols` for an option order → "Outside wheel symbol list"
   - Put strike OTM% < `bot.wheel.otm_pct` × 0.5 (i.e., ≥ 50% closer than the bot would go) → "Strike is more aggressive than wheel parameters"
   - Option DTE outside `[bot.wheel.dte_min - 3, bot.wheel.dte_max + 3]` → "Expiration outside wheel parameters"
5. Return all violations sorted: blocks first, then warns.

### Order form integration

`OrderNew.tsx` calls `POST /api/trades/check` after the user fills the form, before showing the confirm modal. Response feeds two states:

- **No blocks** → confirm modal as today; if any warns, yellow banner above the form fields listing them.
- **Has blocks** → confirm modal red banner; "Confirm Order" disabled; new fields inside the modal:
  - Checkbox: "I'm overriding [N] rule(s) because:"
  - Textarea: required, min 20 chars, max 500
  - Confirm button enables when checkbox + textarea valid
- On submit, the violations array (with optional `override_reason` per blocked rule) saves into `trade.rule_violations`.

### Tendency detection cron (`detect-tendencies` action in `api/cron/[job].ts`)

```ts
// Pseudocode
async function detectTendencies() {
  const trades = await loadClosedTrades({ since: subDays(now, TENDENCY_LOOKBACK_DAYS) });
  const findings: Finding[] = [];

  for (const matcher of MATCHERS) {
    const result = matcher.run(trades);
    if (result) findings.push({ matcher: matcher.name, ...result });
  }

  // 1. Update tendencies (replace by matcher key)
  await writeTendencies(findings.map(toTendency));

  // 2. Generate proposals for actionable findings, deduped against open + dismissed
  for (const finding of findings.filter(actionable)) {
    if (await isAlreadyProposedOrDismissed(finding)) continue;
    const proposal = await sonnetProposeRule(finding);  // 1 LLM call
    await appendProposal(proposal);
  }

  // 3. Demote loop — check existing block-severity rules
  for (const rule of (await loadManualRules()).filter(r => r.severity === 'block')) {
    const stats = computeOverrideStats(rule, trades);
    if (stats.overrides >= 3 && stats.profitable_pct >= 0.6) {
      if (await isDemoteProposalOpen(rule.id)) continue;
      const proposal = await sonnetProposeDemote(rule, stats);
      await appendProposal(proposal);
    }
  }
}
```

**Six matchers** (deterministic, no LLM):

1. **`loss_concentration_by_symbol`** — group by symbol, fire if N≥3, win_rate<40%, total_pnl<0. Key: symbol.
2. **`loss_concentration_by_side`** — group by `(asset_class, option_type)`, fire if N≥5, win_rate<40%. Key: side string.
3. **`cc_below_cost_basis`** — covered calls where strike<entry_basis_of_underlying, fire if N≥2 with ≥1 loss. Key: per-symbol or global.
4. **`held_through_earnings`** — trades open over an earnings date (use cached `fundamentals-fetch.ts`), fire if N≥2 with loss_pct≥50%. Key: symbol.
5. **`override_loss_pattern`** — overridden rules, fire per rule_id if overrides≥3 and loss_pct≥60%. Key: rule_id.
6. **`over_grading_self`** — informational only, fire if avg(your_grade − ai_grade) ≥ 1 letter step over N≥10. No proposal generation, just tendency text.

**Sonnet 4.6 prompt for proposal generation** (~500 tokens cached, ~200 dynamic per call):

```
You are helping a trader convert a detected behavioral pattern into a journal-quality
trading rule.

Context (cached): how rules work in this system, severity levels, trigger DSL grammar,
2 examples of well-formed rules.

Finding (dynamic): {matcher, summary_data, 3-5 evidence trade snippets}

Output JSON: { proposed_rule_title, proposed_rule_body, suggested_severity,
suggested_triggers, reasoning }

Be plain English. No jargon. The body should sound like the trader wrote it for himself.
```

**Demote prompt** is similar — different cached context, output is a `Proposal` with `demote_target_rule_id` set.

**Cron registration:** add to `tools/setup_cronjobs.py`:
```python
{
  "title": "Dashboard — Detect Tendencies",
  "url": f"{DASHBOARD_URL}/api/cron/detect-tendencies?job=detect-tendencies",
  "schedule": {"hours": [22], "minutes": [0], "wdays": [0], ...},  # Sunday 22:00 UTC = 6 PM ET DST
  "headers": [{"name": "Authorization", "value": f"Bearer {CRON_TOKEN}"}],
}
```

### STO assignment auto-spawn

Inside `grade-open-trades` cron (`api/cron/[job].ts`):

```ts
// Existing: iterate trades:index:open, for each option trade, check status
for (const tradeId of openTradeIds) {
  const trade = await getTrade(tradeId);
  if (trade.asset_class !== 'option' || trade.side !== 'sell') continue;

  const order = await alpacaTrade(trade.account, `/v2/orders/${trade.order_id}`);
  if (order.status !== 'filled') continue;

  // ... existing close detection logic
  const { closedVia } = await detectCloseStatus(trade);

  if (closedVia === 'assignment' && trade.option_type === 'put') {
    const positions = await alpacaTrade(trade.account, '/v2/positions');
    const stockPos = positions.find(p => p.symbol === trade.symbol && parseFloat(p.qty) >= 100);
    if (stockPos) {
      await pushAssignmentPending({
        parent_trade_id: trade.id,
        underlying: trade.symbol,
        strike: trade.option_strike,
        qty: 100,
        account: trade.account,
        detected_at: new Date().toISOString(),
      });
    }
  }
}

// Then drain inbox
const pending = await lrange('trades:index:assignments-pending', 0, -1);
for (const entryJson of pending) {
  const entry: AssignmentEntry = JSON.parse(entryJson);
  if (await tradeWithParent(entry.parent_trade_id)) {
    // Already spawned — defensive idempotency
    await lrem('trades:index:assignments-pending', 1, entryJson);
    continue;
  }
  const parent = await getTrade(entry.parent_trade_id);
  const newTrade = buildAssignmentTrade(entry, parent);
  await writeTrade(newTrade);
  await rpush('trades:index:open', newTrade.id);
  await rpush(`trades:index:${monthKey()}`, newTrade.id);
  await lrem('trades:index:assignments-pending', 1, entryJson);
}
```

`buildAssignmentTrade` inherits `tags`, `user_grade`, `ai_grade`, `account` from parent; sets `source: 'assignment'`, `parent_id`, `reasoning: 'Assigned from {parent.option_symbol}'`, `entry_price: strike`, `qty: 100`, `ai_grade_inherited: true`.

**Calibration math exclusion:** `/api/trades/performance` aggregations skip trades where `ai_grade_inherited === true` from the calibration scatter, win-rate-by-tag, and grade-accuracy panels. They DO appear in equity curve, P&L by symbol, and the calendar (since they affect realized P&L).

**DST handling (closes follow-up #3):** all date math in `cron/[job].ts` (option expiration "today is 4 PM ET expiration day" detection, etc.) replaced with helper:

```ts
// dashboard/api/_lib/et-time.ts (new)
export function etDateAt(year: number, month: number, day: number, hour: number, minute = 0): Date {
  // Use Intl.DateTimeFormat to compute the correct UTC offset for a given ET wall-clock time
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'shortOffset', hourCycle: 'h23',
  });
  // Implementation derives offset from the formatted output
  // Returns a Date corresponding to the given ET wall-clock time
}

export function etTodayAt(hour: number, minute = 0): Date { /* ... */ }
export function isOptionExpired(optionSymbol: string): boolean { /* uses etDateAt */ }
```

### `/calendar` data API

`GET /api/trades/calendar?account=...&month=YYYY-MM&symbol=...&tag=...&asset_class=...`

Returns:

```ts
{
  days: {
    [yyyy_mm_dd]: {
      realized_pnl: number;
      trade_count: number;
      closed_trade_ids: string[];
      open_options_expiring: { symbol: string; option_type: 'put'|'call'; strike: number }[];
    };
  };
  month_total: number;
}
```

### `/performance` data API

`GET /api/trades/performance?account=...&date_range=ALL|1Y|3M|1M|1W&tag=...&asset_class=...`

Returns six aggregations in one payload (single round-trip, panels render independently):

```ts
{
  equity_curve: { ts: string; cons: number; agg: number }[];   // already computed elsewhere — reuse
  drawdown: { ts: string; pct: number }[];
  calibration: { trade_id: string; user_grade: number; ai_grade: number }[];  // grades 0-4 (F-A)
  win_rate_by_tag: { tag: string; trades: number; wins: number; total_pnl: number }[];
  pnl_by_symbol: { symbol: string; trades: number; wins: number; total_pnl: number; avg_grade: number }[];
  time_heatmap: { dow: number; hour: number; trades: number; win_rate: number }[];  // dow 0-6, hour 9-16 ET
}
```

### Page implementations

**`/rules` (Rules.tsx):** seven collapsible sections rendered top-to-bottom in this order:

1. Bot rules (read-only, two columns: cons/agg)
2. My rules (cards with severity badges + edit/delete)
3. Playbook patterns
4. Tendencies (read-only)
5. Proposals inbox (badge counter on nav link reflects count of `status === 'open'`)
6. Cheatsheets
7. Goals

Default expansion: 1, 2, 5 expanded; 3, 4, 6, 7 collapsed. Persisted in `localStorage`.

**`/rules/edit` (RulesEdit.tsx):** dispatches by `?section=manual|patterns|cheatsheets|goals|proposals`. Modal-style form per section:

- Manual rule form: title input · severity radio · trigger builder (vertical stack of trigger rows, each with type dropdown + type-specific value field, "+ trigger" button) · body markdown textarea · save/cancel.
- Pattern form: structured fields per parent spec.
- Cheatsheet/goal: simple title+body or body+target+due.
- Proposal-promoted: same as Manual rule form, pre-filled from `proposal.proposed_rule`, "Add to my rules" submit button.

**`/watchlist` (Watchlist.tsx):** rows of `{symbol, added_at, note?}`. Each row pulls live quote + 30-day bars from existing `alpaca/[endpoint].ts`. Add input at top.

**`/calendar` (Calendar.tsx):** standard month grid. Day cell color = realized P&L scaled to month's max abs P&L. Tooltip on hover shows count + sum. Click → drawer w/ closed trade list. Expiration overlay: small icon badges per option expiring that day. Filter bar across top: account · symbol · tag · asset class. Month navigator + jump-to-month picker.

**`/performance` (Performance.tsx):** single page, six panels, filter bar at top applies to all.
- Equity curve uses existing Phase 1 component, takes overlay flag for both accounts.
- Drawdown chart: line chart, lightweight-charts v5.
- Calibration scatter: custom SVG, dots + 45° reference line.
- Win-rate-by-tag: horizontal bar chart, sorted by trade count.
- Per-symbol table: sortable HTML table.
- Time-of-day heatmap: 5×7 grid of cells (Mon-Fri × 9 AM-3 PM ET), green-to-red intensity.

## Sequencing

| # | Milestone | Brief |
|---|---|---|
| 1 | Bot rules pipe + data model foundations | `bot:rules` push from workflows · `kv-keys.ts` whitelist · `Trade` type extensions · `assignments-pending` plumbing skeleton |
| 2 | Rules API + storage + active rule-checker | `api/rules/[resource].ts` · `rule-check.ts` real implementation · `api/trades/check` action · order form rule banner + block-override modal |
| 3 | `/rules` + `/rules/edit` pages | Read-only rules display · trigger builder UI · all four edit modals · proposal approve/dismiss/edit-then-add |
| 4 | Tendency cron + cron-job.org registration | Six matchers · Sonnet proposal generation · demote loop · register Sunday 6 PM ET cron |
| 5 | STO assignment auto-spawn | Detection in `grade-open-trades` · drain inbox · spawn follow-on · `parent_id` link UI on `/trade/:id` · DST helper (closes follow-up #3) |
| 6 | `/watchlist` + `/calendar` + `/performance` | Watchlist page · calendar grid + drawer · performance page (all six panels) · supporting API actions |
| 7 | Cleanup follow-ups + final QA | `LIVE_ENABLED` 403 guard · TS warning at `api/alpaca/[endpoint].ts:38` · end-to-end smoke test (place rule-violating trade → override → close → grade → tendency proposal cycle) |

## Testing strategy

Phase 2 baseline: 97 vitest tests. Phase 3 target: ≥130 tests (delta ≥33).

**New unit-test surfaces:**
- `rule-check.ts` evaluator — one test per trigger type plus combination tests for ALL-must-match semantics
- Trigger DSL serialization (round-trip JSON)
- Tendency matchers — table-driven tests with synthetic trade fixtures
- Proposal dedup (same matcher + key dimension within window doesn't re-propose; previously dismissed doesn't re-propose)
- Assignment detection idempotency (running cron twice produces one spawned trade, not two)
- `etDateAt` helper across DST boundaries (March + November transitions)
- Live-account 403 guard
- Calendar/performance aggregation correctness (filter combinations)

**New integration-test surfaces:**
- Rules API CRUD round-trip per resource
- Order submit with rule violation captures `rule_violations` correctly
- Approve flow promotes proposal → manual rule, sets `resolved_at`
- Demote flow patches existing rule severity

**Manual smoke test (end of milestone 7):**
1. Create a manual block-severity rule "no TSLA puts under 7 DTE"
2. Try to place a TSLA put with 5 DTE → block fires → enter override reason → confirm
3. Verify trade record has `rule_violations` populated with `override_reason`
4. Close trade at a loss
5. Manually trigger `detect-tendencies` cron via curl
6. Verify a proposal appears on `/rules` (override_loss_pattern after 3 such overrides — for smoke test, lower lookback threshold or seed prior overrides)

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| AI proposes nonsense rules | Approve/dismiss inbox keeps human in loop; deterministic matchers gate the LLM input |
| Rule-checker false positives on edge orders | Bot rules always warn-only; manual rules user-authored so user's responsibility |
| `bot:rules` partial-merge introduces races between cons + agg pushes | Use Redis transaction (MULTI/EXEC) on `bot:rules` reads + writes; or per-mode keys `bot:rules:cons` / `bot:rules:agg` if simpler |
| Assignment detection misclassifies non-assignment closes | Conservative — only fire on `option_type === 'put'`, `side === 'sell'`, status `filled`, and stock position matching underlying with qty ≥ 100 acquired ≥ expiration day |
| Function-count budget creeps over 12 | Strict catchall pattern — all new endpoints fold into existing `[resource]` / `[action]` files unless otherwise impossible |
| Tendency cron Sonnet costs balloon | Hard cap: max 6 finding-proposal + 6 demote-proposal calls per run = ≤ 12/week ≈ 48/month; cached prompt block (~500 tok) reused |
| `/calendar` and `/performance` complexity stalls Phase 3 | Keep API single-payload + panel-independent rendering — heaviest component (heatmap) can ship as a v0 if needed without blocking the rest |

## Vercel function inventory (post-Phase 3)

Function count: **9 → 10 of 12**.

```
auth/[action].ts          (existing)
alpaca/[endpoint].ts      (existing)
kv/[resource].ts          (existing)
bot-state.ts              (existing, extended)
fundamentals.py           (existing)
fundamentals-proxy.ts     (existing)
trades/[action].ts        (existing, extended +check +calendar +performance)
settings/[resource].ts    (existing)
cron/[job].ts             (existing, extended +detect-tendencies +assignment-spawn)
rules/[resource].ts       NEW
```

2 functions still in reserve for Phase 4 (daily-review cron + ?).

## Env var additions

None new — Phase 3 reuses Phase 2's `ANTHROPIC_API_KEY` (proposal generation), `CRON_TOKEN` (tendency cron), `BOT_PUSH_TOKEN` (rules push).

Optional: `LIVE_ENABLED=false` (default) for follow-up #2 — only set to `true` when live trading is actually wired up.

## Open questions / left for plan-writing phase

- Exact JSON shape of bot rules push payload vs `BotRulesPayload` type — verify by writing the `tools/push_rules_to_dashboard.py` against real `config.MODES` data
- Trigger builder UI exact dropdown widths and validation copy — defer to plan
- Sonnet prompt token counts (cached vs dynamic) — measure against ~500 cached / ~200 dynamic budget during implementation
- Calendar P&L color scale — linear vs log — pick during implementation, easy to swap

## Definition of done

- All 5 pages live and reachable from main nav (existing Layout.tsx)
- Active rule-checker fires on order placement; block-override flow recorded on trade
- Tendency cron registered and producing proposals weekly
- Approve/dismiss/edit-then-add flow working from `/rules`
- STO assignment auto-spawns linked stock trade; calibration math correctly excludes inherited grades
- 3 follow-ups landed (live guard, DST helper, TS warning)
- ≥ 130 vitest tests passing
- One full end-to-end smoke test recorded (rule violation → override → close → tendency cycle)
- Deployed to production via `npx vercel --prod` from `dashboard/`
- PR merged to main
