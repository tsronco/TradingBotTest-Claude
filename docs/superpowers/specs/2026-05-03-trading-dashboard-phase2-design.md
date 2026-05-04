# Trading Dashboard — Phase 2 Design Spec

**Status:** approved by user during brainstorming; ready for implementation planning
**Date:** 2026-05-03
**Author:** Tim + Claude (brainstorming session)
**Parent spec:** [`2026-05-02-trading-dashboard-design.md`](2026-05-02-trading-dashboard-design.md)

## Purpose

Phase 2 turns the read-only Phase 1 dashboard into a manual trading platform with AI-graded honesty. By the end of Phase 2, Tim can:

- Place a stock or single-leg option order from the cab in under 60 seconds.
- See an entry-grade-with-reasoning requirement on every order, with a stub rule-checker on the confirm modal.
- Read an honest AI hindsight grade (Sonnet 4.6, plain English, no jargon) on every closed manual trade — auto-fired by a cron when Alpaca reports the close.
- Browse all manual trades on `/trades` with a three-number summary band (count / win rate / calibration ratio) and a filterable table.
- Configure TOTP thresholds, manage tags, and rotate backup codes from `/settings`.
- Modify and cancel open orders from `/orders`.

Phase 2 explicitly does NOT ship: active AI rule-checker (Phase 3), tendency detection (Phase 3), daily coach note (Phase 4), `/calendar`, `/performance`, `/rules`, `/watchlist` listing, PWA shell (Phase 4).

## Goals

- One mostly-vertical-stacked order form that feels deliberate and obvious from the cab — no wizards, no hidden fields, exposure visible at all times.
- Required entry grade + free-text reasoning that locks at submit. Re-grades only refresh AI hindsight, never the user's entry.
- Two-step confirm with TOTP re-prompt above per-account `$` exposure thresholds.
- Auto-grading: Vercel cron polls open trades every 5 min during market hours, fires `/api/grade-trade` per newly-closed trade, grade is waiting next time the trade detail page loads.
- Calibration metric (your-grade vs AI-grade delta) surfaced as the headline diagnostic on `/trades`.
- Architecture stays under the Vercel Hobby 12-function limit. Net new functions: 3.

## Non-goals

- Multi-leg option spreads, brackets, OCO orders, crypto manual trading.
- Active AI rule-checker — Phase 2 ships a stub (1× sizing / earnings-7d / bot-wheel-overlap) only.
- Tendency detection from trade-data patterns.
- Daily AI coach note (Phase 4).
- Live-money UI activation. The `live` threshold is configurable but `LIVE_ENABLED=false` keeps the UI paper-only.
- Auto-following an option assignment into a stock trade record (deferred to Phase 3 — see "Open implementation decisions").

## Decisions locked during brainstorming

| # | Topic | Decision |
|---|---|---|
| 1 | Build sequence | settings → order form → trade detail → grading → history → modify/cancel |
| 2 | Settings scope | tags list + TOTP thresholds + backup-codes regenerate (no notification prefs in v1 — Phase 4 territory) |
| 3 | Settings layout | tabbed: `[thresholds] [tags] [recovery]` |
| 4 | Order form entry | context-driven via query params (`?symbol=…&type=stock` or `?contract=…&action=open\|close`); blank `/order/new` falls back to symbol-search |
| 5 | Stock order form layout | vertical stack, one section per `━━━` divider |
| 6 | Option order form layout | matches stock form's vertical stack; header carries strike/expiry/PUT-CALL color; side toggle is `[BTO][STO]` for opening or fixed for closing; Greeks auto-snapshot at submit; qty caps at position size when closing |
| 7 | Confirm modal | one component, two states: phosphor-green border below threshold; amber border + TOTP field above |
| 8 | Rule-check on modal | stub in Phase 2 (1× sizing / earnings-7d / bot-wheel-overlap). Phase 3 upgrades the same UI slot with the active AI checker |
| 9 | Trade detail layout | stacked: header → chart → timeline → grades side-by-side → tags+journal |
| 10 | Grading trigger | Vercel cron `*/5 13-20 * * 1-5` UTC polls `trades:index:open`, fires `/api/grade-trade` for newly-closed |
| 11 | Re-grading | explicit `[re-grade*]` button only. Journal/tag edits do not trigger AI calls |
| 12 | Trade history | three-number summary band (count / win rate / calibration ratio) above filterable table. Full perf dashboard stays Phase 3 |
| 13 | Modify/cancel routes | bolt-on to existing `api/alpaca/[endpoint].ts` catchall (thin SDK wrappers) |
| 14 | AI model | `claude-sonnet-4-6` everywhere; prompt caching wired even though Phase 2's cached block is small |
| 15 | AI tone | "Honest trading coach. Plain English only. Grade decision-making, not outcomes. Call out wrong-thesis credit-taking." |

## Architecture additions

Phase 2 adds 3 new serverless functions and wires the order/grade lifecycle into the existing dashboard. No bot-side code changes.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  React SPA (existing) — adds /settings · /order/new · /trade/:id · /trades   │
│                          plus modify/cancel actions on /orders               │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │ session-cookie auth (existing)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  API routes — Phase 2 additions in **bold**                                   │
│                                                                                │
│  api/                                                                          │
│  ├── auth/[action].ts            (existing) login | logout | session          │
│  ├── alpaca/[endpoint].ts        (existing + bolt-ons) account | positions |  │
│  │                                orders | quote | chain | news | bars |      │
│  │                                equity-history | **modify-order** |         │
│  │                                **cancel-order**                            │
│  ├── kv/[resource].ts            (existing) bot-state | watchlist             │
│  ├── bot-state.ts                (existing) bot push webhook                  │
│  ├── fundamentals.py             (existing) yfinance Python edge function     │
│  ├── fundamentals-proxy.ts       (existing) TS proxy                          │
│  ├── **trades/[action].ts**      preview | submit | list | get | regrade      │
│  ├── **settings/[resource].ts**  thresholds | tags | backup-codes             │
│  └── **cron/[job].ts**           grade-open-trades                            │
│                                  (future home for daily-review,               │
│                                  detect-tendencies in Phase 3-4)              │
└─────┬─────────────────────────────────────┬──────────────────────────────────┘
      │                                     │
      ▼                                     ▼
┌──────────────────────┐           ┌─────────────────────────┐
│   Vercel KV          │           │  Alpaca Trading API     │
│   + trade:* records  │           │  + manual orders        │
│   + grade:* records  │           │    (paper now,          │
│   + indexes          │           │     live future)        │
│   + settings keys    │           │                         │
└──────────────────────┘           └─────────────────────────┘
                                              ▲
                                              │
                                   ┌──────────────────────┐
                                   │  Claude API          │
                                   │  claude-sonnet-4-6   │
                                   │  hindsight grades    │
                                   │  (prompt caching)    │
                                   └──────────────────────┘
```

**Function count after Phase 2:** 9 of 12 Hobby-plan functions. Phase 3 (`api/cron/[job].ts` already in place; will gain `daily-review` and `detect-tendencies` actions inside it) and Phase 4 stay under the limit.

## Page layouts

### `/settings` — tabbed

- pbtn tabs at the top: `[thresholds] [tags] [recovery]`. Only one section visible at a time.
- **Thresholds tab**: three rows (`conservative_paper`, `aggressive_paper`, `live`), inline `$` inputs, single `[save*]` button. The `live` row is editable but shows the dim suffix `(LIVE_ENABLED=false)` to flag that the threshold isn't yet enforced anywhere.
- **Tags tab**: pill grid of all entries from `tags:list`. Each pill has a `×` to remove. A `+ add` pill at the end opens an inline text input. No edit (rename) — delete + re-add.
- **Recovery tab**: status line (`8 codes active · last regenerated YYYY-MM-DD`), `[regenerate*]` button. Click pops a TOTP-verified dialog, returns the 8 fresh plaintext codes one time in a copy-able block. User confirms they've saved the codes before the dialog closes; closing without confirmation logs a warning but does not roll back.

Reads/writes:
- thresholds → `config:totp_thresholds`
- tags → `tags:list`
- backup codes → `auth:backup_codes_hashed` (KV — see Open implementation decisions)

### `/order/new` — context-driven, vertical stack

**Entry contract.** Always loaded with query params:
- Stock: `/order/new?symbol=TSLA&type=stock&account=conservative_paper`
- Option open: `/order/new?contract=TSLA260522P00280000&action=open&account=conservative_paper`
- Option close: `/order/new?contract=TSLA260522P00280000&action=close&account=conservative_paper`

Bare `/order/new` shows a symbol-search prompt (`tim@dash:~/portfolio$ pick a symbol → /lookup/SYM`).

**Header.**
- Title: `Order — TSLA` (stock) or `Order — TSLA PUT $280 05/22/2026` (option, with PUT/CALL colored red/cyan per brand).
- Subtitle: `// stock · conservative_paper` or `// option · opening · conservative_paper · 19 DTE`.
- Live quote line: `last $321.40 · bid $321.35 · ask $321.45` (stock) or `stock $321.40 · option bid $4.20 / ask $4.30 · OI 12,840` (option).
- Position-context line: `you hold: 10 sh @ $315.20` or `your position: −1 STO @ $4.25 · +54% profit` or `— no position`.

**Body sections** (each preceded by an `━━━` divider in the brand style):

| Section | Stock | Option (open) | Option (close) |
|---|---|---|---|
| greeks | — | auto-snapshot read-only (Δ Γ Θ ν IV) | auto-snapshot read-only |
| side | `[buy*][sell][sell_short]` | `[BTO][STO*]` | `[BTC*]` or `[STC*]` (forced by position; no toggle) |
| type | `[limit*][market][stop][stop-limit][trailing]` | `[limit*][market]` | `[limit*][market]` |
| size & price | qty + (limit / stop / trail params) + tif | contracts + limit + tif | contracts (capped at position size) + limit + tif |
| entry/exit grade | letter picker A+ → F | A+ → F | A+ → F |
| reasoning | required textarea | required textarea | required textarea |
| tags | pill toggle from `tags:list` + `+ add` | same | same |

**Footer.**
- Live exposure readout (computed via spec's exposure table): `exposure: $3,214.00 · below $5k threshold · no totp re-prompt` or `≥ $5k threshold · totp required`.
- For option close: includes realized P&L preview (`close cost: $200 · realized: +$225 (+54%)`).
- Buttons: `[cancel]` and `[review*]`.

`[review*]` opens the confirm modal (next section). The form preserves state if the user clicks `[back]` from the modal.

### Confirm modal — two states (one component)

**State A — below threshold:**
- Phosphor-green border (`#22ff88`).
- Title: `review & confirm`. Subtitle: `// step 1 of 2 · below totp threshold`.
- Body sections (each a `━━━` divider): order summary · entry grade echo (letter + reasoning) · rule-check (3 stub checks).
- Buttons: `[back]` (returns to form preserving state) · `[cancel]` · primary `[place order*]`.

**State B — above threshold:**
- Amber border (`#ffb454`) — warning state per brand.
- Title: `review & confirm`. Subtitle: `// step 2 of 2 · ≥ $5k threshold · totp required`.
- Same body sections plus a `━━━ totp code ───` section with a 6-digit input field and helper text.
- Buttons: `[back]` · `[cancel]` · primary `[verify & place*]` (amber).

**Server-side decision.** The state is picked based on `/api/trades/preview`'s `requires_totp` response, computed by comparing `exposure_at_submit` against `config:totp_thresholds[account]`.

### `/trade/:id` — stacked detail

Loaded with `id` route param. Pulls `{ trade, grade }` from `/api/trades/get`.

**Header.**
- Title: `Trade T-2026-05-04-001`. Subtitle: `// BUY 10 TSLA · conservative_paper · closed 2026-05-04`.
- Right-aligned big realized P&L readout: `+$425.00 · +13.4%` (green or red per sign, with `▲`/`▼`).

**Card stack** (each card uses the brand's ASCII corner ornament):

1. **CHART** — TradingView Lightweight chart, 1h bars across position lifetime. Entry marker (`▲ entry $319.85`) and exit marker (`▼ exit $362.20`) overlaid. For options: underlying stock chart, not the option chart (option bar history is sparse).
2. **TIMELINE** — rows for `submitted` / `filled` / `peak` / `closed` events with timestamps, prices, qtys. Pulled from Alpaca order events on the linked `alpaca_order_id` and `alpaca_close_order_id`.
3. **GRADES** — two-column inside the card. Left: your entry grade letter (large card) + reasoning quote. Right: AI hindsight letter (large card, colored by calibration delta — green if matches, amber if 1-step over/under, red if 2+) + plain-English review + tendencies-hit pills (amber). Calibration line below: `over by 1 step` / `matched` / `under by 1 step` etc. `[re-grade*]` button at the right. While grading is in progress, the right side shows `// grading… (sonnet 4.6)` with a `.pulse` indicator. If `parse_failed`, shows `// manual review needed — last raw output below` and a collapsible code block.
4. **TAGS · JOURNAL** — tag pills (editable any time) + optional journal textarea. Empty journal renders `<span className="text-dim">— empty —</span>` per brand.

### `/trades` — summary band + table

**Summary band** (3 cells across the top, each in a small ASCII-cornered card):
- `count` — total trades in current filter set.
- `win rate` — `% of closed trades with realized_pnl > 0`. Computed only on `status: closed` rows.
- `calibration` — formatted as `graded N · over X · under Y · matched Z` where each number reflects the `grade.hindsight.calibration` field across closed+graded trades.

**Filter pills** below the summary:
- account · asset class · tag · grade · status · date range. All reflect to URL query params for shareable filtered views.

**Table.**
- Columns: date · symbol · side · qty · entry · exit · P&L · entry grade · AI grade · tags.
- Newest first by default. Sortable on any column header.
- Click row → `/trade/:id`.
- P&L column uses `▲`/`▼` per brand.
- Grade columns colored by calibration delta (green if matches, amber if 1-step off, red if 2+).
- Pagination: `limit=50`, `offset=0` query params; `[< prev] [next >]` pbtn pair at bottom.

### `/orders` — modify/cancel additions (existing page)

Each open-order row gains two trailing actions: `[modify]` and `[cancel]`.

- `[modify]` opens an inline form (or modal — implementation pick during plan-writing) with editable price/qty/TIF. Submits to `/api/alpaca/modify-order`.
- `[cancel]` confirms once then sends to `/api/alpaca/cancel-order`. No TOTP re-prompt for cancels regardless of size — the original submit's TOTP suffices.

## Data model

### Trade record (`trade:{id}`)

```jsonc
{
  "id": "T-2026-05-04-001",
  "account": "conservative_paper",        // | "aggressive_paper" | "live"
  "asset_class": "stock",                  // | "option"
  "symbol": "TSLA",
  "side": "buy",                           // stock: buy|sell|sell_short
                                           // option: BTO|STO|BTC|STC
  "qty": 10,
  "order_type": "limit",                   // market|limit|stop|stop_limit|trailing  (stocks)
                                           // market|limit                            (options)
  "limit_price": 321.40,
  "stop_price": null,
  "trail_pct": null,
  "tif": "day",                            // day|gtc

  "contract_symbol": null,                 // option only, e.g. "TSLA260522P00280000"
  "strike": null,
  "expiration": null,                      // ISO date
  "contract_type": null,                   // "put" | "call"
  "greeks_at_entry": null,                 // { delta, gamma, theta, vega, iv }

  "alpaca_order_id": "abc-123-xyz",
  "alpaca_close_order_id": null,

  "submitted_at": "2026-05-04T13:30:00Z",
  "filled_at":    "2026-05-04T13:30:15Z",
  "filled_avg_price": 319.85,
  "closed_at":    null,
  "closed_avg_price": null,
  "realized_pnl": null,                    // dollars; populated on close
  "closed_by": null,                       // null | "manual" | "expired" | "assigned"

  "tags": ["breakout", "sized_down"],
  "entry_grade": "A",                      // letter: A+,A,A-,B+,B,B-,C+,C,C-,D,F
  "entry_reasoning": "breakout above $318. low IV. sized half — earnings 2w out.",
  "journal": "",                           // optional, editable any time

  "exposure_at_submit": 3214.00,
  "rule_warnings_at_entry": [],            // [{rule, severity, message}]

  "schema": 1
}
```

**ID format:** `T-YYYY-MM-DD-NNN`. NNN comes from `trades:counter:{YYYY-MM-DD}` (resets daily).

### Grade record (`grade:{id}`)

```jsonc
{
  "trade_id": "T-2026-05-04-001",
  "entry": {
    "letter": "A",
    "reasoning": "breakout above $318. low IV. sized half — earnings 2w out.",
    "ts": "2026-05-04T13:30:00Z"
  },
  "hindsight": {
    "letter": "B+",
    "review": "thesis was right. you got lucky on the size — demand surprise drove it, not earnings risk. graded down: don't take credit you didn't earn.",
    "calibration": "over_1",                // matched | over_1 | over_2 | under_1 | under_2
    "tendencies_hit": ["credited_wrong_thesis"],
    "model": "claude-sonnet-4-6",
    "usage": { "input_tokens": 1942, "output_tokens": 287, "cached_tokens": 0 },
    "ts": "2026-05-06T14:11:08Z"
  },
  "history": []                              // prior {entry, hindsight} snapshots from re-grades
}
```

`entry` is locked at submit and never changes. On `[re-grade*]`, the current `hindsight` snapshots to `history[0]` (unshift), then a fresh call writes a new `hindsight`.

### Indexes

| Key | Type | Contents |
|---|---|---|
| `trades:index:open` | array<string> | open trade IDs (added on submit, removed on close) |
| `trades:index:{YYYY-MM}` | array<string> | all trade IDs in that month, append-only |
| `trades:counter:{YYYY-MM-DD}` | integer | daily NNN counter |

### Settings + auth keys

| Key | TTL | Contents |
|---|---|---|
| `tags:list` | none | array of tag strings, seeded with: `breakout, morning_setup, pullback, earnings_play, wheel, wheel_50pct, delta_target, sized_down, scale_in, trim, stop_hit` |
| `config:totp_thresholds` | none | `{ conservative_paper: 5000, aggressive_paper: 10000, live: 1500 }` |
| `auth:backup_codes_hashed` | none | array of 8 SHA-256 hashed backup codes (single-use). Migration target — see "Open implementation decisions" |

### KV-key whitelist split

`dashboard/api/_lib/kv-keys.ts` gets two whitelists:

- `BOT_PUSH_KEYS` — what the bot bearer token can write. Existing five keys, unchanged.
- `DASHBOARD_KEYS` — what an authenticated session can write. New: `trade:*`, `grade:*`, `trades:index:*`, `trades:counter:*`, `tags:list`, `config:totp_thresholds`, `auth:backup_codes_hashed`.

Bot pushes never touch trade-related keys. Dashboard sessions never touch bot state.

### Storage sizing

Per-trade footprint: ~1.5 KB (trade record + grade record + indexes). 100 trades/year → 150 KB. Free tier 256 MB. Not a concern.

## API endpoints

All session-gated unless noted. All catchall-routed to stay under the 12-function Hobby limit.

### `POST /api/trades/preview`
**Auth:** session.
**Body:** full order draft.
**Logic:**
1. Validate fields (limit price required for limit; trail_pct for trailing; reasoning non-empty; grade is a valid letter; etc.).
2. Compute `exposure_at_submit` per the parent spec's exposure table.
3. Run stub rule-check (see "Stub rule-check" section).
4. Compare `exposure` against `config:totp_thresholds[account]`.

**Response:**
```jsonc
{
  "exposure": 3214.00,
  "requires_totp": false,
  "rule_warnings": [{ "rule": "earnings_within_7d", "severity": "warn", "message": "..." }],
  "validation_errors": []
}
```

### `POST /api/trades/submit`
**Auth:** session + (TOTP code if `requires_totp`).
**Body:** full order draft + optional `totp_code`.
**Logic:**
1. Re-run preview validation server-side (never trust client).
2. If `requires_totp`, verify TOTP fresh against `TOTP_SECRET`. Mismatch → 401.
3. Submit order to Alpaca via SDK trading client. Capture `alpaca_order_id`.
4. Generate trade ID, increment `trades:counter:{YYYY-MM-DD}`.
5. Write `trade:{id}` and `grade:{id}` (with only `entry` populated).
6. Push trade ID onto `trades:index:open` and `trades:index:{YYYY-MM}`.
7. For options on opening orders: snapshot Greeks via `alpacaData()` `options/snapshots` and store on the trade record.

**Response:** `{ id: "T-2026-05-04-001", alpaca_order_id: "..." }`.

### `GET /api/trades/list`
**Auth:** session.
**Query:** `account`, `asset_class`, `tag`, `grade`, `status`, `from`, `to`, `limit`, `offset`.
**Logic:** pull IDs from `trades:index:{YYYY-MM}` keys covering the date range, mget all trade records in batches, filter in-memory.

**Response:** `{ trades: [...], summary: { count, win_rate, calibration: { over, under, matched } } }`.

### `GET /api/trades/get?id=T-...`
**Auth:** session.
**Returns:** `{ trade, grade }` — both records merged for the detail page.

### `POST /api/trades/regrade`
**Auth:** session.
**Body:** `{ id }`.
**Logic:**
1. Read `trade:{id}` and `grade:{id}`.
2. Snapshot current `grade.hindsight` to `grade.history[0]` (unshift).
3. Build prompt (cached rules block + fresh trade data).
4. Call Claude. Parse structured JSON. On malformed: retry once with stricter prompt; if still bad, store `parse_failed: true` flag with raw output, return `{ ok: false, raw: "..." }`.
5. Write fresh `hindsight` block.
6. Return `{ grade: {...} }`.

### `POST /api/alpaca/modify-order` & `POST /api/alpaca/cancel-order`
Bolt-ons to existing `api/alpaca/[endpoint].ts`.
- `modify-order` — body: `{ order_id, qty?, limit_price?, stop_price?, tif? }`. SDK PATCH `/v2/orders/{id}`.
- `cancel-order` — body: `{ order_id }`. SDK DELETE.

Both use the SDK (trading domain works fine per the known quirks).

### `CRON /api/cron/grade-open-trades`
**Schedule:** `*/5 13-20 * * 1-5` (UTC; CDT market-hours, see DST note).
**Auth:** Vercel cron header (`x-vercel-cron`).
**Logic:**
1. mget all IDs from `trades:index:open`.
2. For each: fetch the linked Alpaca order(s). If position is closed (close-order filled, expiration passed, assignment), proceed.
3. For each newly-closed: compute `closed_avg_price`, `realized_pnl`, `closed_at`, `closed_by`. Write back to `trade:{id}`. Remove from `trades:index:open`.
4. Build grading prompt (cached block + 1-min bars during position lifetime via `alpacaData()` + trade record + entry grade/reasoning).
5. Call Claude. Parse JSON. Write `grade:{id}.hindsight`.
6. Concurrency cap: max 3 trades graded per cron tick to stay under the 10s Hobby timeout. Surplus waits for the next tick.

**DST note:** `13-20` UTC covers CDT market hours (March–November). When DST ends in early November, shift to `14-21` UTC. Same drift as the bot workflows already documented in CLAUDE.md.

### `GET|POST /api/settings/thresholds`
**Auth:** session.
- GET → returns `config:totp_thresholds`.
- POST → body `{ conservative_paper, aggressive_paper, live }`. Validates positive integers. Writes to KV.

### `GET|POST|DELETE /api/settings/tags`
**Auth:** session.
- GET → `tags:list`.
- POST → body `{ tag }`. Adds (idempotent, lowercase, trimmed).
- DELETE → body `{ tag }`. Removes.

### `POST /api/settings/backup-codes`
**Auth:** session + TOTP code (treat as sensitive action).
**Logic:**
1. Verify TOTP fresh.
2. Generate 8 fresh codes via `generateBackupCodes()` from `_lib/backup-codes.ts`.
3. Hash each, write to `auth:backup_codes_hashed` in KV.
4. Return the 8 plaintext codes one time (server never stores plaintext).

## Stub rule-check (Phase 2 only)

Three pure-data checks, run server-side in `/api/trades/preview`. All return `{ rule, severity, message }`. None block submit — Phase 2's job is to surface warnings; the user decides.

| Check | Severity | Logic |
|---|---|---|
| `sizing_1x` | `info` | `qty > 20` (stock) or `qty > 1` (option). Message: `"order is N× normal size. reason should explain."` |
| `earnings_within_7d` | `warn` | yfinance `next_earnings_date` exists and 0 ≤ `(date - today)` ≤ 7. Message: `"earnings on YYYY-MM-DD (in N days). consider sizing down or waiting."` |
| `bot_wheel_overlap` | `warn` | `bot:state:conservative[symbol].stage ∈ {1, 2}` OR `bot:state:aggressive[symbol].stage ∈ {1, 2}`. Message: `"bot has an open wheel on SYM in <account>. manual position will share BP."` |

**Edge cases:**
- yfinance unavailable → silently skip the earnings check (don't fabricate a pass).
- bot state missing or stale (last update >24h ago) → skip the overlap check, log to errors channel.

All warnings save to `trade.rule_warnings_at_entry` exactly as returned. Audit trail for "did I have an earnings warning when I entered this?" filtering on `/trades`.

## AI grading prompt structure

Per parent spec: Sonnet 4.6, prompt caching, structured JSON, plain-English no-jargon.

### System prompt (uncached, ~300 tokens)

```
You are an honest trading coach for a single trader (Tim). Your job is
to grade a closed manual trade A+ to F based on what actually happened
versus what the trader said when entering.

Hard rules:
- Plain English only. Never use trader shorthand (LH, LL, HOD, RR, IV,
  RSI, theta, delta, gamma, vega) without defining it inline in the
  same sentence.
- If the trader made a bad call, say so directly. No hedging, no
  cheerleading. The point is to improve, not to feel good.
- Grade the *decision-making*, not the outcome. A bad process that
  got lucky still gets a low grade. A good process that got unlucky
  still gets a high grade.
- Compare against the trader's own entry reasoning. If they took
  credit for something that wasn't the actual driver, call it out.
- "tendencies_hit" is a list of pattern names from the provided
  tendencies set. Empty array if none apply. Do not invent new ones.

Output strict JSON. No prose outside the JSON. Schema:
{
  "letter": "A+|A|A-|B+|B|B-|C+|C|C-|D|F",
  "review": "<plain-english review, 60-120 words>",
  "calibration": "matched|over_1|over_2|under_1|under_2",
  "tendencies_hit": ["<tendency-id>", ...]
}

"calibration" compares your letter to the trader's entry letter:
"matched" = same letter
"over_1"  = trader was 1 step too high
"over_2"  = trader was 2+ steps too high
"under_1" = trader was 1 step too low
"under_2" = trader was 2+ steps too low
```

### Cached block (1-hour TTL, ~300 tokens in Phase 2)

- `rules:manual` — Phase 2 placeholder note: `"manual rules not yet defined — grade based on trade record alone."`
- `rules:tendencies` — empty array in Phase 2.
- `rules:patterns`, `rules:cheatsheets` — empty in Phase 2.

The `cache_control: { type: "ephemeral" }` marker is set even though the cached block is small, so Phase 3 immediately benefits when those keys fill in.

### Fresh block (uncached, ~1K tokens)

- Trade record (full JSON minus sensitive fields like `alpaca_order_id`).
- Order timeline (submitted/filled/peak/closed events).
- 1-minute price bars for the position lifetime via `alpacaData()`.
- For options: Greeks at entry.
- Entry grade letter + entry reasoning.

### Cost (Phase 2)

~2K input + 300 output tokens per grade ≈ $0.012 per grade. At 100 trades/year → $1.20/year. Well under spec's $17/year ceiling because the cached block is small for now.

### Failure handling

- Claude API down → trade stays ungraded; UI shows `[grade now*]` button. Never silent.
- Malformed JSON → retry once with stricter system prompt. If still bad, store `parse_failed: true` with raw output, surface "Manual review needed" UI.
- Always log model + token counts to `grade:{id}.hindsight.usage` for cost tracking.

## "What counts as closed?" definition (for the grading cron)

| Trade type | Closed condition | `closed_by` |
|---|---|---|
| Stock long (`buy`) | A `sell` order on the same symbol/account fills with `qty ≥` open qty | `"manual"` |
| Stock short (`sell_short`) | A `buy_to_cover` order fills with matching qty | `"manual"` |
| Option BTO | Matching STC fills | `"manual"` |
| Option BTO | Expiration date passes (worthless) | `"expired"` |
| Option STO | Matching BTC fills | `"manual"` |
| Option STO | Expiration date passes (worthless — kept full premium) | `"expired"` |
| Option STO | Assignment (Alpaca order with `event=assigned`) | `"assigned"` |

The cron correlates close orders to open trades by `(account, symbol, asset_class)` — first match wins, FIFO. Two open trades on the same symbol: the older one closes first when a partial close matches its qty.

For STO closed by expiration: `closed_avg_price = 0`, `realized_pnl = filled_avg_price × 100 × qty` (full premium kept).

For STO closed by assignment: marked `closed_by: "assigned"` and graded normally. The resulting stock position is **not** auto-tracked as a follow-on trade in Phase 2 — see "Open implementation decisions".

## Open implementation decisions (resolved during plan-writing)

These are not blocking the spec, but the Phase 2 implementation plan needs to settle them:

1. **Backup codes storage migration.** Currently `BACKUP_CODES_HASHED` is a Vercel env var. Rotating it from a serverless function requires Vercel API + redeploy, which we don't want from a request handler. Resolution: **migrate to KV at `auth:backup_codes_hashed`**. One-time migration: read env var, write to KV, leave env var in place as a fallback for one release cycle, then remove. The `verifyBackupCode()` helper in `_lib/backup-codes.ts` reads KV first, env var second.

2. **Assignment follow-on tracking.** When an STO is closed by assignment, the resulting 100 shares appear in the Alpaca account but are not currently tracked as a manual trade. Phase 2 leaves this alone (the option trade closes cleanly, gets graded, and the user can manually create a follow-on trade if desired). Phase 3 may auto-create the follow-on. Plan-writing decision: confirm "leave alone in Phase 2" and document the user-facing behavior (the assigned stock will show up on `/positions` but not on `/trades`).

3. **Modify-order UI: inline form vs modal.** Inline keeps the user on `/orders` with full context; modal is more focused but adds an extra layer. Plan-writing decides — likely modal to match the confirm pattern.

4. **Trade ID counter race.** `trades:counter:{YYYY-MM-DD}` increment must be atomic. Use `INCR` on the Upstash Redis client (atomic by definition). Plan-writing confirms the helper used.

5. **Calibration computation source.** `/api/trades/list` summary computes calibration ratio from `grade.hindsight.calibration` — but only on closed+graded trades. Trades that are closed-but-ungraded don't contribute. Plan-writing confirms whether ungraded-closed trades should appear in the count separately (e.g. `graded N · ungraded M · over X · under Y · matched Z`).

6. **TradingView lib pick on `/trade/:id`.** Phase 1 used the Advanced Chart widget on `/lookup`. The trade detail page wants entry/exit markers, which are easier with Lightweight Charts (Advanced doesn't expose marker API on the free widget). Plan-writing confirms Lightweight, accepts the slightly different visual rhythm.

7. **Trade history pagination strategy.** Naïve `mget` of all trade IDs in a date range works fine at 100 trades/year. Plan-writing confirms no need for indexed pagination cursors yet.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| User submits an order, server crashes between Alpaca submit and KV write | Order goes to Alpaca but no trade record exists. Mitigation: order submit returns `alpaca_order_id` first, KV write happens before the response is sent. If KV write fails, log `orphan_alpaca_order` to errors channel — manual reconciliation needed but data is recoverable from Alpaca. |
| Cron fires while market is opening, prices haven't settled | Grading uses 1-min bars from the position lifetime. If `closed_at` is within the last 5 minutes, the cron skips the grade and waits for the next tick. |
| TOTP code expires between preview and submit | Server validates TOTP fresh on submit. If the user hits "Verify & Place" with a stale code, server returns 401. UI shows "TOTP code expired — re-enter." |
| Claude returns a grade for the wrong trade ID | Grading prompt includes the trade ID in the fresh block; the server cross-checks the response against the request ID. Mismatch → discard, retry. |
| Two cron ticks process the same trade | `trades:index:open` removal happens before grading. If the cron crashes mid-grade, the trade is gone from `:open` but ungraded. UI shows `[grade now*]`. |
| Backup codes rotated while user has active session | Active sessions stay valid (TOTP is the secondary factor; sessions are independent). Only future logins are affected. |
| Modify-order on a partially-filled order | Alpaca rejects with `OrderModificationFailed` error. UI surfaces the error message verbatim. No state corruption. |
| User cancels the close order on a wheel position mid-grade | The grading cron checks position status fresh per tick; if the close was canceled, the trade goes back into "open" status (re-add to `trades:index:open`), no grade is written. |

## Success criteria

Phase 2 is "done enough" when:

- Tim can place a manual stock or single-leg option order from the cab, with grade + reasoning required, in under 60 seconds.
- TOTP re-prompt fires reliably above the configured `$` threshold per account.
- Within 5 minutes of a manual trade closing on Alpaca, a hindsight grade appears on `/trade/:id` with plain-English review, no jargon, and a calibration tag.
- `/trades` shows total count, win rate, and calibration ratio at a glance, with filters that update both the table and the summary band.
- `/settings` lets Tim adjust TOTP thresholds, manage tags, and rotate backup codes — all without redeploying or touching env vars.
- Tim can modify and cancel open orders from `/orders`.
- All Phase 1 functionality continues to work unchanged.

## Implementation plan

This spec is the input to Phase 2 plan-writing. The plan will be organized by milestone matching the build sequence: settings → order form (stock then option) → confirm modal → trade detail → grading pipeline → trade history → modify/cancel.

Each milestone ends in a green test run + manual paper-trade walkthrough on Vercel preview before merging. Final merge to `main` only after end-to-end validation on a real paper trade.
