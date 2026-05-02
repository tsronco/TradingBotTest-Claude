# Trading Dashboard — Design Spec

**Status:** approved by user; ready for implementation planning (phase by phase)
**Date:** 2026-05-02
**Author:** Tim + Claude (brainstorming session)

## Purpose

A personal web dashboard, hosted on Vercel, that does two jobs:

1. **Bot cockpit** — show what the existing TradingBotTest-Claude bots are doing across both paper accounts (conservative + aggressive) at a glance, with no risk to bot operation.
2. **Manual trading platform** — let Tim place stocks and single-leg options orders from the cab, with required pre-trade reasoning, an AI honesty layer that grades the trade after close, and a strategy-rules page that warns him before he breaks his own rules.

The dashboard is a hybrid of two reference designs Tim provided: the *Portfolio for Alpaca* iOS app (positions / orders / trade) and the *SMB TIM DASH 2026* journaling/grading dashboard from the SMB Capital "build your own AI trading assistant with Claude" video.

The dashboard is for one user (Tim). All data, auth, and operational decisions are sized for single-user simplicity.

## Goals

- One URL to see everything happening across both bot accounts.
- Place a manual stock or option order from the cab in under 60 seconds, with grade + reasoning required.
- Honest AI feedback on every closed manual trade, in plain English (no trader jargon).
- A rules/playbook reference Tim can pull up in 30 seconds before placing a trade, with active rule-checking on order placement.
- Architecture that supports a future live-money account as a config change, not a rewrite.
- Bots stay completely operational even if the dashboard is down.

## Non-goals (deliberate)

- Multi-user or family-shareable.
- Multi-leg option spreads, crypto manual trading, bracket/trailing-stop combos in v1.
- Backtesting, strategy generation, signal-finding, or any "AI tells you what to trade" features.
- Replacing the Discord notification system — Discord stays as-is for bot-side alerts.
- Real-time tick data or Level 2 order books.
- Mobile-native (iOS/Android) app — PWA only.

## Decisions locked during brainstorming

| # | Topic | Decision |
|---|---|---|
| 1 | Primary purpose | Bot cockpit + manual trading on top |
| 2 | Account scope | Both paper accounts now; design for live money later |
| 3 | Hosting + stack | Vercel, React + Vite + Tailwind (matches StashSlip) |
| 4 | Authentication | Hardcoded password env var + TOTP 2FA |
| 5 | Data backbone | Vercel KV (Upstash Redis via Marketplace) for dashboard data; Alpaca API for live state |
| 6 | Bot state visibility | Bots POST state JSON to `/api/bot-state` at end of each workflow run |
| 7 | AI grading scope | Manual trades only; entry grade (user) + hindsight grade (AI); grade-accuracy as headline metric |
| 8a | Order types (v1) | Stocks: market, limit, stop-loss, stop-limit, trailing stop. Options: single-leg open/close. No spreads, no crypto, no brackets |
| 8b | Confirm flow | Two-step confirm modal; TOTP re-prompt above per-account `$` threshold (configurable) |
| 9 | Lookup page contents + layout | Quote · TradingView chart · options chain w/ all 5 Greeks · wheelability · news · earnings (Robinhood-style) · fundamentals · position context · watchlist toggle. Layout = dashboard grid, earnings under options chain |
| 10 | Trade-detail page contents | Header · chart w/ entry/exit markers · order timeline · entry grade + reasoning · AI hindsight + feedback · side-by-side grade comparison · tags · tendencies hit · optional journal · re-grade button. Tags = fixed list + "+ Add new" |
| 11 | Rules page contents + AI behavior | All 6 sections: bot rules (auto from `config.py`) → manual rules → playbook patterns → tendencies → cheatsheets → goals. AI is active rule-checker on order placement, override-able, no grade suggestion |
| 12 | Daily ritual | Auto AI coach's note at 4:15 PM ET via Vercel cron; journal field exists but fully optional and never prompted; tendencies detected from trade-data patterns, not write-ups |
| 13 | Earnings/fundamentals data source | yfinance via Python edge function (no new accounts) |
| 14 | AI model | `claude-sonnet-4-6` everywhere; no Opus calls |
| 15 | AI tone | Plain English; no trader jargon (LH, LL, HOD, RR, etc.) without inline definition |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Browser / PWA (Tim only)                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS, signed session cookie
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                Vercel — the dashboard (NEW)                  │
│  ┌──────────────────┐    ┌──────────────────────────────┐  │
│  │  React SPA       │◄──►│  API routes (serverless)     │  │
│  │  Vite + Tailwind │    │  /api/auth/*    /api/orders/*│  │
│  │  TradingView     │    │  /api/bot-state /api/grade-* │  │
│  │  PWA shell (P4)  │    │  /api/check-order /api/cron/*│  │
│  └──────────────────┘    └──┬──────────┬─────────┬──────┘  │
└──────────────────────────────┼──────────┼─────────┼─────────┘
                               │          │         │
              ┌────────────────┘          │         └──────────────┐
              ▼                            ▼                        ▼
┌──────────────────────┐  ┌─────────────────────────┐  ┌──────────────────────┐
│   Vercel KV          │  │  Alpaca Trading API     │  │  Claude API          │
│   (Upstash Redis)    │  │  positions, orders,     │  │  claude-sonnet-4-6   │
│   bot state, trades, │  │  market data, options,  │  │  hindsight grades,   │
│   grades, rules,     │  │  news (paper now,       │  │  daily coach note,   │
│   tags, watchlist    │  │  live future)           │  │  tendency detection  │
└──────────────────────┘  └─────────────────────────┘  └──────────────────────┘
        ▲
        │ POST after each cycle (curl, fire-and-forget)
        │
┌─────────────────────────────────────────────────────────────┐
│       GitHub Actions (existing repo, +1 step per workflow)   │
│  tsla-monitor · wheel · congress-copy · daily-summary        │
└─────────────────────────────────────────────────────────────┘

(Plus: yfinance via a single Python edge function for fundamentals + earnings.
 TradingView widget loaded as JS from tradingview.com, free.)
```

**Why this shape:**
- Dashboard reads bot state from KV (sub-50ms) instead of GitHub raw or re-running bot logic.
- Dashboard reads positions/orders/quotes/options live from Alpaca — never stale, no caching needed.
- Dashboard writes only to KV (its own data) and Alpaca (orders).
- Bots stay completely independent. The dashboard depends on the bots; the bots never depend on the dashboard.

## Phasing

Each phase ends in a working, useful product. Each gets its own implementation plan.

### Phase 1 — Foundation + read-only dashboard
"I can SEE everything from one URL" milestone. No buttons that touch your account from the dashboard.

- Vercel project provisioned, custom domain wired (`dash.<your-domain>`)
- Vite + React + Tailwind scaffold
- Vercel KV provisioned via Marketplace
- Auth: `/login` (password + TOTP), session cookies, rate limiting, backup codes
- Bot-state push endpoint (`POST /api/bot-state`) + bearer-token auth
- All five workflows updated with one curl step (`if: always()`, fire-and-forget)
- One-time manual workflow trigger to backfill KV
- Pages: `/login`, `/` (home), `/positions`, `/orders` (read-only), `/lookup/:symbol`
- TradingView widget integration on `/lookup`
- yfinance Python edge function for fundamentals + earnings
- Alpaca news feed on `/lookup`
- Dual-account UX: home page shows both accounts side-by-side; `/positions` and `/orders` have an account selector pill (Conservative · Aggressive · Both)
- "Add to watchlist" button + `watchlist` KV key working from `/lookup`. Dedicated `/watchlist` listing page deferred to Phase 3 — until then, the watchlist data is captured but only viewable by inspecting KV directly

### Phase 2 — Manual trading + grading
- Pages: `/settings`, `/order/new`, `/trade/:id`, `/trades`
- Order form supports stocks (market/limit/stop/stop-limit/trailing) and single-leg options (open/close)
- Required entry grade + reasoning fields on order form
- Two-step confirm modal; TOTP re-prompt above per-account `$` threshold
- Tag system (fixed list + "+ Add new" inline)
- AI hindsight grading on close (`/api/grade-trade`), Sonnet 4.6, prompt caching
- Manual re-grade button on `/trade/:id`
- Modify/cancel open orders from `/orders`
- Validated end-to-end on paper before being called complete

### Phase 3 — Rules / playbook / coaching
- Pages: `/rules`, `/rules/edit`, `/watchlist`, `/calendar`, `/performance`
- Bot rules auto-pulled from `config.py` (parser fetches from GitHub raw with 5-min cache)
- Manual rules + playbook patterns + cheatsheets + goals editable
- Active rule-checker on order placement (`/api/check-order`) — warns + override
- Tendency detection from trade-data patterns (Sunday cron `/api/cron/detect-tendencies`)

### Phase 4 — Daily ritual + polish
- Vercel cron at 4:15 PM ET → `/api/cron/daily-review` → AI coach's note for the day
- Coach's note appears on home page when next opened
- PWA setup (manifest, service worker, install prompt) for cab access
- Optional push notification at 4:15 PM (off by default)
- Final accessibility + performance audit
- Error boundaries, friendly error pages

## Data model (Vercel KV)

KV is a flat key-value store. We namespace keys with colons.

### Bot state (written by workflows, read by dashboard)

| Key | Contents | Updated by |
|---|---|---|
| `bot:state:conservative` | full `wheel_state.json` payload | `tsla-monitor.yml`, end of run |
| `bot:state:aggressive` | full `wheel_state_aggressive.json` payload | `tsla-monitor-aggressive.yml` |
| `bot:strategy:conservative` | full `strategy_state.json` | `tsla-monitor.yml` |
| `bot:strategy:aggressive` | full `strategy_state_aggressive.json` | `tsla-monitor-aggressive.yml` |
| `bot:congress` | summary of recent congress trades | `congress-copy.yml` |
| `bot:last-update:{key}` | ISO timestamp of last successful POST per key | every push |

### Manual trades

| Key | Contents |
|---|---|
| `trade:{id}` | single trade record (full JSON) |
| `trades:index:open` | array of open manual trade IDs |
| `trades:index:{YYYY-MM}` | array of trade IDs in that month |
| `trades:counter` | monotonic counter for IDs |

**Trade record example:**
```json
{
  "id": "T-2026-05-02-001",
  "account": "conservative_paper",
  "asset_class": "stock",
  "symbol": "TSLA",
  "side": "buy",
  "qty": 10,
  "order_type": "limit",
  "limit_price": 320.00,
  "alpaca_order_id": "abc-123-xyz",
  "submitted_at": "2026-05-02T13:30:00Z",
  "filled_at": "2026-05-02T13:30:15Z",
  "filled_avg_price": 319.85,
  "closed_at": null,
  "closed_avg_price": null,
  "realized_pnl": null,
  "tags": ["breakout", "morning_setup"],
  "entry_grade": "A-",
  "entry_reasoning": "Breakout above $318 resistance, low IV, sized half normal due to earnings next week",
  "journal": "",
  "rule_warnings_at_entry": []
}
```

For options, add: `contract_symbol`, `strike`, `expiration`, `contract_type` (put/call), `greeks_at_entry` (snapshot of Δ Γ Θ ν IV at submission).

### Grades (separate from trade for re-gradeability)

| Key | Contents |
|---|---|
| `grade:{trade-id}` | `{ entry: {letter, reasoning, ts}, hindsight: {letter, feedback, model, ts}, history: [...prior gradings] }` |

Re-grading appends to `history`, never overwrites.

### Rules / reference

| Key | Contents |
|---|---|
| `rules:manual` | array of `{id, rule, why}` — discretionary rules |
| `rules:patterns` | array of playbook patterns (each with `environment`, `variables`, `legs`, `rules`, `win_rate`) |
| `rules:tendencies` | array of `{id, name, description, source: "user" \| "ai", first_seen, count}` |
| `rules:cheatsheets` | array of `{title, body}` |
| `rules:goals` | current year's goals — `{year, focus, target, progress}` |

Bot rules are NOT in KV. They are parsed live from `config.py` (fetched from GitHub raw, 5-minute cache).

### Misc

| Key | Contents | TTL |
|---|---|---|
| `tags:list` | array of tag strings | none |
| `watchlist` | array of symbols | none |
| `daily-review:{YYYY-MM-DD}` | `{coach_note, trades_summary, generated_at}` | none |
| `session:{cookie-id}` | `{logged_in_at, last_active}` | 30 days |
| `config:totp_thresholds` | `{conservative_paper: 5000, aggressive_paper: 10000, live: 1500}` | none |

**Sizing estimate:** under 5 MB at year 1 (200 trades + 200 grades + 365 daily reviews + 50 patterns). KV free tier is 256 MB.

## Bot integration (state-push contract)

The bots get one extra step per workflow. No other code changes.

### Endpoint contract

```
POST https://dash.<your-domain>/api/bot-state
Content-Type: application/json
Authorization: Bearer ${BOT_PUSH_TOKEN}

{
  "key": "bot:state:conservative",
  "payload": { ...full state JSON... }
}
```

- `key` must be in the server-side whitelist: `bot:state:conservative`, `bot:state:aggressive`, `bot:strategy:conservative`, `bot:strategy:aggressive`, `bot:congress`. Anything else → 400.
- On success: server stores `payload` at `key` and writes `bot:last-update:{key}` with current ISO timestamp.

### Auth

- One new env var on Vercel: `BOT_PUSH_TOKEN` = a random 64-char string.
- Same value added as a GitHub Actions secret.
- Server compares the bearer token; mismatch → 401.
- Distinct from TOTP auth — bots never log in.

### Workflow step (added to each workflow)

```yaml
      - name: Push state to dashboard
        if: always()                # run even if previous step failed
        env:
          BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
        run: |
          curl -fsS --max-time 10 \
            -X POST https://dash.<your-domain>/api/bot-state \
            -H "Authorization: Bearer $BOT_PUSH_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$(jq -n --slurpfile p wheel_state.json \
                       '{key: "bot:state:conservative", payload: $p[0]}')" \
            || echo "Dashboard push failed (non-fatal)"
```

Three properties to preserve:
1. `if: always()` — partial state is still useful.
2. `--max-time 10` — workflow doesn't block on a slow dashboard.
3. `||` failure-swallow — bots keep trading even if the dashboard is down.

### Per-workflow mapping

| Workflow | Pushes |
|---|---|
| `tsla-monitor.yml` | `bot:state:conservative` + `bot:strategy:conservative` |
| `tsla-monitor-aggressive.yml` | `bot:state:aggressive` + `bot:strategy:aggressive` |
| `congress-copy.yml` | `bot:congress` |
| `wheel-screener.yml` | (no push — screener writes Discord only) |
| `daily-summary.yml` | (no push — reads same KV the dashboard already populated) |

### Dual-write, single source of truth

State files in the repo continue to be written and committed exactly as today. KV is a fast-read mirror. Reasons:
- Dashboard outage → bots unaffected.
- Local debugging (`/health`, `/positions`, `/wheel-status` skills) keeps reading from disk.
- Free version-history of every state change via git.

### Backfill

When Phase 1 ships, KV is empty. First action: manually trigger one run of each workflow (`gh workflow run`) to populate. From then on, every scheduled run keeps it fresh.

## AI grading mechanics

Three places Sonnet 4.6 is called. All use prompt caching to keep costs at ~$17/year worst case.

### 1. Hindsight grade — `POST /api/grade-trade`

**Trigger:** auto on trade close (Alpaca fill detected, or user marks expired option closed). Manual re-grade button on `/trade/:id` always available.

**Prompt structure (~4K input tokens, ~300 output):**
- System: "Honest trading coach. Plain English only — no LH, LL, HOD, RR, etc. without inline definition."
- Cached block (3K, 1-hour TTL): manual rules + tendencies + patterns + cheatsheets
- Fresh block (1K): trade record, order timeline, 1-min bars during position lifetime, user's entry grade + reasoning

**Output (structured JSON):**
```json
{
  "grade": "B+",
  "calibration": "over",
  "review": "<plain-English honest review>",
  "tendencies_hit": ["stubbornness_after_failed_hold"]
}
```

**Cost:** ~$0.005 per grade. ~$12.50/year worst case.

### 2. Daily coach note — `CRON /api/cron/daily-review` at 4:15 PM ET weekdays

**Trigger:** Vercel cron, weekdays only. Reads today's closed manual trades and produces a 1-paragraph wrap-up.

**Prompt structure (~5K input, ~500 output):**
- Cached block (same as #1)
- Fresh: today's closed trades + grades + tendencies fired + 7-day grade-accuracy trend + bot state summary

**Output:** plain text wrap-up, 100-150 words, stored in `daily-review:{YYYY-MM-DD}`.

**Cost:** ~$0.007 per day. ~$1.75/year.

### 3. Tendency detection — `CRON /api/cron/detect-tendencies` Sundays

**Trigger:** Sunday evening cron. Looks at last 30 days of trades for patterns appearing 3+ times.

**Prompt structure (~15K input, ~500 output):**
- Cached block
- Fresh: last 30 days trade history + existing tendencies (so they aren't re-found)

**Output (structured JSON):** new tendencies with name, description, count, evidence trade IDs. Appended to `rules:tendencies` with `source: "ai"`.

**Cost:** ~$0.05 per run. ~$2.60/year.

### Caching strategy

- Sonnet 4.6 prompt caching, 1-hour TTL, applied to the rules/tendencies/patterns/cheatsheets block. ~90% cost reduction on cached portion.
- Single model everywhere — no A/B routing.
- Structured outputs (JSON) — no wasted prose tokens.

### Failure handling

- Claude API down on grading: trade stays "ungraded" with a "Retry grading" button. Never silent.
- Claude API down on cron: home page shows "Coach's note unavailable today — retry tomorrow."
- Malformed JSON: retry once with stricter prompt; if still bad, show raw output with "Manual review needed." Never fake a grade.

### Honest-feedback guardrail (system prompt language)

Every grading + coaching system prompt includes:

> *"Write for a learner. Don't use trader shorthand (LH, LL, HOD, RSI, RR, IV, etc.) without defining it in the same sentence. If the trader made a bad call, say so directly — no hedging, no cheerleading. The point of grading is to improve, not to feel good."*

## Authentication flow

### Setup (one-time)

1. Generate password and TOTP secret. Store in Vercel env vars:
   ```
   DASHBOARD_PASSWORD=<random 32-char string>
   TOTP_SECRET=<base32-encoded secret>
   SESSION_SECRET=<random 64-char string>      # signs auth cookies
   BOT_PUSH_TOKEN=<random 64-char string>      # see bot integration
   BACKUP_CODES=<8 hashed one-time codes>      # comma-separated
   ```
2. Scan TOTP QR into Google Authenticator / Authy / 1Password.
3. Save the 8 backup codes somewhere safe.

### Login flow

1. Visit any protected route → redirected to `/login`.
2. `/login` shows password + TOTP fields. Submitted together (single POST to `/api/auth/login`).
3. Server validates: password matches `DASHBOARD_PASSWORD` AND TOTP code is current (30-sec window) for `TOTP_SECRET`.
4. On success: HTTP-only, signed, secure session cookie set with 30-day TTL. KV entry `session:{cookie-id}` written with `last_active`.
5. Failed attempts rate-limited (5 failures from same IP → 15-min lockout). Logged.

### Session lifecycle

- 30-day rolling expiration. Each request bumps `last_active`.
- Cookie attributes: `HttpOnly; Secure; SameSite=Strict`.
- Logout clears cookie + deletes KV session entry.
- "Logout everywhere" in settings: deletes all `session:*` keys.

### TOTP re-prompt above order threshold

When submitting an order on `/order/new`:
1. Frontend POSTs to `/api/orders/preview` with order details. Server computes `$` exposure value.
2. If value ≥ threshold for that account (from `config:totp_thresholds`): server returns `{requires_totp: true}`.
3. Order form shows TOTP code field. User enters current 6-digit code.
4. Frontend re-POSTs to `/api/orders/submit` with TOTP code attached.
5. Server validates TOTP fresh (no caching) before sending order to Alpaca.

Below threshold → normal two-step confirm modal, no TOTP re-prompt.

**`$` exposure value calculation** (used to compare against `config:totp_thresholds`):

| Order type | Exposure |
|---|---|
| Stock buy | `qty × limit_price` (or current ask if market order) |
| Stock sell | `qty × limit_price` (or current bid if market order) |
| Option buy-to-open | `qty × ask × 100` (premium paid) |
| Option sell-to-open (CSP) | `strike × qty × 100` (cash secured) |
| Option sell-to-open (CC) | `qty × bid × 100` (premium received — usually small, rarely triggers TOTP) |
| Option buy-to-close | `qty × ask × 100` |
| Option sell-to-close | `qty × bid × 100` |

### Lost-phone recovery

- 8 backup codes (single-use, hashed in env var) generated at setup.
- Use any one to log in instead of TOTP for that session.
- Settings page has "Generate new backup codes" — invalidates old ones.

### Why not Clerk?

Tim already uses Clerk on StashSlip. Roll-your-own here keeps a one-user app from being yet another vendor relationship. Migration cost to Clerk later is low — sessions are just an env-secret-signed cookie with no Clerk-specific assumptions.

## Page hierarchy summary

```
Auth
  /login                       — password + TOTP

Daily
  /                            — home: snapshot, both accounts, today's trades, AI coach's note
  /positions                   — all positions across both accounts (stocks + options w/ Greeks)
  /orders                      — open + filled today; cancel/modify open
  /watchlist                   — saved symbols → click to /lookup

Trading
  /lookup/:symbol              — quote, chart, options chain, wheelability, news, earnings, fundamentals, position context
  /order/new                   — order placement, required entry grade, rule-checker, two-step confirm + TOTP if over threshold
  /trade/:id                   — trade detail, AI grade vs your grade, tags, tendencies, optional journal, re-grade

History
  /trades                      — all manual trades, filterable
  /calendar                    — P&L heatmap by day
  /performance                 — equity curve, grade-accuracy %, win rate by tag, head-to-head conservative vs aggressive

Reference
  /rules                       — bot rules (auto from config.py) + manual rules + patterns + tendencies + cheatsheets + goals
  /rules/edit                  — edit your manual rules / patterns / cheatsheets

Settings
  /settings                    — tags list, TOTP thresholds per account, notification prefs

Backend (not user-facing)
  POST /api/bot-state          — bot-state push webhook
  POST /api/grade-trade        — Claude hindsight grade
  POST /api/check-order        — rule-checker pre-submit
  CRON /api/cron/daily-review        — 4:15 PM ET weekdays
  CRON /api/cron/detect-tendencies   — Sunday evenings
  POST /api/auth/login         — password + TOTP login
  POST /api/auth/logout
  GET  /api/orders/preview     — order preview + threshold check
  POST /api/orders/submit      — order submit (with TOTP if required)
  POST /api/orders/:id/cancel
  POST /api/orders/:id/modify
```

## Open implementation decisions (resolved during plan-writing, not here)

These are not blocking the spec, but Phase 1 plan-writing will need to settle them:

1. **Domain choice** — `dash.fattieslearnscoding.com` vs new domain vs subdomain of a future bot-related domain. Likely Tim's call; default suggestion: `dash.fattieslearnscoding.com`. The Phase 1 plan must resolve this before deploy. The placeholder `<your-domain>` appears throughout this spec — final value substituted at Phase 1 plan time.
2. **TradingView widget version** — Lightweight Charts vs Advanced Chart widget. Advanced is richer but heavier; Lightweight is fast and free.
3. **yfinance edge function pattern** — Vercel Python runtime supports it natively. Confirm cold-start latency is acceptable (<1s).
4. **Component library** — pure Tailwind, or shadcn/ui on top? StashSlip likely already establishes a pattern; copy it.
5. **State management** — Tanstack Query for server state, plain React state for UI. Probably no Zustand/Redux for this scope.
6. **Testing scope** — vitest unit tests for grading logic, rule-checker, order validation. Playwright for the auth + order-submit happy paths. No need to over-test simple display pages.
7. **Bot rules parser** — write a small AST-aware parser of `config.py` (using a Python library like `libcst`) or a simpler regex-based extractor for the specific fields we care about. Probably regex first; upgrade if it gets brittle.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Dashboard goes down | Bots unaffected (they don't depend on it). State files in repo are still authoritative. |
| KV free tier limit hit | Sized for ~5 MB year-one usage. Free tier is 256 MB. Not a realistic concern. |
| Claude API outage during grading | Trade stays "ungraded," surfaces a "Retry" button. Never silently fakes a grade. |
| TOTP secret leaked | Rotate in env vars, redeploy. All sessions stay valid; only TOTP changes. |
| Session cookie stolen | 30-day TTL bounds exposure. "Logout everywhere" wipes all sessions. TOTP re-prompt for big orders limits the worst-case loss. |
| yfinance breaks (Yahoo HTML changes) | Earnings/fundamentals panel shows "data unavailable." Doesn't break other pages. Replace yfinance with Finnhub free tier if it becomes chronic. |
| Going live before adding live-account safeguards | Live account threshold is a separate config entry. Live-account UI is gated behind a `LIVE_ENABLED=true` env flag (not added until Tim is ready). |
| Bots run with stale dashboard schema after a code change | The bot-state contract is intentionally minimal: bots POST whatever JSON they have, dashboard parses defensively. Schema changes on the bot side don't break the dashboard. |

## Success criteria

The dashboard is "done enough" when:

- **Phase 1:** Tim can log in, see both accounts' equity / positions / open orders / today's bot trades on one page, and look up any symbol's chart + options chain + Greeks + news + earnings.
- **Phase 2:** Tim can place a manual stock or option order in under 60 seconds from the cab, with grade + reasoning required, and the trade appears in `/trades` with an AI hindsight grade after close.
- **Phase 3:** Tim can pull up `/rules` and see his bot rules + his own discretionary rules in one place. Trying to place a trade that violates a rule pops a warning he can override.
- **Phase 4:** Tim opens the dashboard the morning after market close and the AI coach's note for yesterday is sitting on the home page.

## Implementation plans

This spec defines all four phases. Implementation plans are written separately, one per phase, when Tim is ready to start each phase. The next step after this spec is approved is to write the **Phase 1 implementation plan**.
