# Small-Account Auto-Spread — Design

> **Standalone effort.** Three new low-balance paper accounts (`sm500` / `sm1000` / `sm2000`) that manage hand-opened positions exactly like `manual`, **and** autonomously open risk-defined put credit spreads screened from the existing wheel universe. Plus a dashboard group-view account selector covering all 7 accounts.

**Status:** Design **finalized** — all 6 open decisions resolved by Tim 2026-05-15 (see Resolved decisions). Companion implementation plan being written.

**Branch:** `claude/small-account-auto-spread` (off `main`, which now contains the mobile + order-form work via #18/#19).

## Goal

Tim created a second paper-only Alpaca signup with 3 accounts seeded at **$500 / $1,000 / $2,000**. He wants them to:

1. Behave like **`manual`** — auto-discover and manage everything he opens by hand (spreads, puts, calls, stock).
2. **Plus a brand-new autonomous opener:** each cycle, screen the existing wheel-screener universe, score candidates, and on a high-scoring symbol that clears an earnings check, **auto-open a put credit spread** (defined risk) — *instead of* a cash-secured put, because these accounts' buying power is far below the CSP-affordability line.
3. Show up on the dashboard, with a **group-view account selector** (Small / Core / Hands-on) so he can view related accounts together.

## What's genuinely new (this is bigger than "another mode")

Nothing in the bot opens spreads today. `manual` opens *nothing* (`wheel_skip_new_puts: True`). `conservative`/`aggressive` auto-open **cash-secured puts only**, from a **static symbol list**, and never spreads. The wheel-screener scores a universe but is **advisory-only and weekly** — it has never placed an order. This effort introduces the **first autonomous, screener-driven, spread-opening engine in the system.** That is the single most autonomous piece of trading logic in the codebase — the design treats it accordingly (heavy guardrails, conservative defaults, earnings exclusion).

## The accounts

Separate paper-only Alpaca signup (staff-sanctioned; not a second live brokerage — verified 2026-05-15). `.env` already has the full credential + Discord set for all three (verified, names only): `ALPACA_SM{500,1000,2000}_{API_KEY,API_SECRET,BASE_URL}`, `DISCORD_SM{500,1000,2000}_{TRADES,SUMMARY,ERRORS,ACTIONS}_WEBHOOK`. **Tim still needs to mirror these as GitHub Actions secrets** for hosted runs (he does the secrets; the plan will list exactly which).

## Behaviour model

Each SM mode = **manual's flags** + a **new auto-open engine**:

| Flag | Value | Effect |
|---|---|---|
| `auto_discover_symbols` | `True` | Discover & manage every position held (same as manual) |
| `spread_management` | `True` | Manage spreads (50% profit / 50% max-loss / DTE-floor) — same as manual |
| `wheel_skip_new_puts` | `True` | **Keep the static-list CSP wheel OFF** (we do NOT want the conservative-style fixed-list wheel here) |
| `auto_open_spreads` | `True` *(new flag)* | Enable the new screener-driven spread opener |
| *(new param block)* | see defaults table | Universe, score threshold, BP switch, spread construction, risk rails, earnings guard |

Key insight: the new opener is a **separate code path** from the `WHEEL_SKIP_NEW_PUTS`-gated `_sell_new_put()`. Keeping `wheel_skip_new_puts: True` cleanly disables the old static-list CSP wheel while the new `auto_open_spreads` engine runs independently. Management of *hand-opened* positions is 100% inherited from manual — no new management code.

## The auto-open engine in detail

### Universe & scoring (reuse, don't duplicate)

- **Universe:** reuse the existing wheel-screener scoring against a **conservative "happy to own" pool, expanded to ~50–100 names** (RESOLVED: Tim wants the existing ~40-name conservative pool broadened so there are enough candidates; proposed target **~60** vetted large-cap names within his 50–100 ask). The aggressive high-IV pool is **deferred** — added later only if the accounts grow (RESOLVED #5).
- **sm500 cheap-underlying filter (RESOLVED #3):** sm1000/sm2000 screen the full pool; **sm500 screens only underlyings priced ≤ ~$25** (proposed default, tweakable) so a minimum-width put credit spread can actually fit its risk cap and the account can still try to make money rather than perpetually no-trading. This is a per-mode universe filter, not a separate list.
- **DRY refactor:** `score_candidate(symbol, free_bp)` currently lives in `wheel_screener.py` and is CLI-only (entangled with Discord output). The plan will **extract the scoring core into a shared importable module** (e.g. `screener_core.py`) that *both* the existing weekly screener CLI and the new auto-opener import — one implementation, no logic drift. The screener CLI's behavior/output stays byte-identical.
- **Score-scale mismatch (must resolve — open decision #1).** The real score is `premium_yield*100 − spread_pct*50 + budget_fit*5` ≈ a 0–15 range (typical 4–8), **not** 0–100. Tim thinks in "90/100." Proposed: after scoring the day's screened universe, **normalize to a 0–100 "wheelability"** by percentile-ranking within that cycle's candidates (so "90" = "top ~10% of today's screened names"). Gate auto-open on `wheelability ≥ threshold` (proposed default **90**). This makes Tim's mental model real and self-calibrating regardless of absolute score drift. Alternative considered: raw-score min-max normalize to 0–100 (more sensitive to outliers). **Percentile is the proposal.**

### BP gate (CSP vs spread)

- If `options_buying_power ≥ $5,000` → would open a **cash-secured put** (existing conservative-style).
- If `options_buying_power < $5,000` → open a **put credit spread** instead.
- SM accounts are always < $5k → in practice **spread-only**. The switch is built **generally** (a reusable helper) so it can later apply to conservative/aggressive if Tim ever wants BP-aware behavior there, but for SM it resolves to spreads every time. `$5,000` is a tweakable default (open decision — Tim's off-the-cuff number).

### Spread construction (proposed defaults — tweak these)

Put credit spread (bullish/neutral, defined risk — matches the dashboard spread form and the "less profit, capped risk" intent):

- **Short put:** ~10% OTM (reuse manual's `put_strike_pct: 0.10`) / near the conservative wheel delta.
- **Long put:** one strike interval below the short, sized so the **width** satisfies the max-risk cap.
- **DTE:** 14–28 (reuse manual wheel DTE).
- **Net credit target:** the mid of (short bid − long ask) … (short ask − long bid), like the dashboard FillHint "balanced".

### Risk rails (this is the de-risking — Tim chose all-3-live, no soak)

Because there's no validation buffer, **safety lives entirely in these guards + conservative defaults.** Every one is enforced before an order is placed:

- **`max_risk_pct_equity`** (proposed **12%**): a spread's max loss `(width × 100)` must be ≤ this fraction of account equity. *Consequence, now mitigated for sm500:* a $1-wide spread = $100 max loss = 20% of a $500 account, which the 12% cap rejects. RESOLVED #3 — rather than let sm500 perpetually no-trade, sm500 screens only **cheap underlyings (≤ ~$25)** where the cheapest available spread width is more likely to fit the 12% cap, so it can still attempt small defined-risk trades. sm500 remains the most constrained account (it may still no-trade on days nothing cheap clears the cap + earnings + score gauntlet) — that's acceptable; the cap is never relaxed, only the universe is narrowed to give it a fighting chance.
- **`min_net_credit`** (proposed **$0.05** /share): reject a spread whose computed `net_credit (short_mid − long_mid)` is below the floor. A thin/illiquid chain can yield `long_mid ≥ short_mid` → zero or negative credit. Zero credit pins `_compute_spread_pnl`'s `profit_pct` to `0.0` forever (`… if net_credit > 0 else 0.0`), so the 50%-profit close can never fire — the spread becomes un-manageable on the profit exit. Negative credit is a disguised **debit** spread placed via the credit-convention order, with `max_loss = width − net_credit > width`, busting the risk cap that only validated `width`. Enforced between the score/earnings/BP gauntlet and `_open_spread_mleg`: below-floor symbols are skipped (continue to the next eligible candidate, not a hard return).
- **`max_concurrent_spreads`** (proposed **3** for sm1000/sm2000; effectively 0–1 for sm500 by the risk cap).
- **`account_floor`** (proposed: skip all opens if equity < **$300**): don't trade a near-dead account.
- **BP-fit:** only open if `options_buying_power ≥ spread max loss (collateral) + buffer`.
- **Earnings exclusion** (proposed **7 days**): skip any symbol whose next earnings is within N days. The wheel's own documented rule is "no earnings in the next 2–4 weeks before selling premium" — an autonomous opener **must** enforce this or it does exactly what the manual rules warn against.
- **One open per cycle:** at most **1** new spread opened per account per cycle (screen → best eligible candidate → open → stop), to avoid a burst filling the account in one tick.

### Earnings data (must resolve — open decision #2)

The **bot has no earnings data at all** today (the screener explicitly skips it; only the dashboard's serverless yfinance function has it, unreachable from the bot). Proposed: **add `yfinance` to the bot** and fetch next-earnings inline in the auto-opener, cached per run, wrapped in the same bounded-retry pattern the bot already uses for Alpaca (`_alpaca_request`-style). Alternative: have the bot call the dashboard's `fundamentals-proxy` endpoint (couples bot→dashboard at runtime — weaker). **Recommendation: yfinance-in-bot.** This adds a dependency and a (rate-limited) external call per screened symbol — the per-cycle universe is small and results are cached, so it's acceptable.

### Order placement

The bot has **no spread-OPEN primitive** — only `_close_spread_mleg()` (multi-leg buy-to-close). The plan adds a new `_open_spread_mleg()` mirroring its structure: `order_class: "mleg"`, legs = STO short put (`position_intent: sell_to_open`) + BTO long put (`buy_to_open`), limit = target net credit. On fill, the spread is seeded into `wheel_state_*.json` as the existing `stage: "spread_active"` shape so the **inherited manual `handle_spread()` management takes over exits** — **no new exit logic; we reuse what already manages hand-opened spreads.**

### Per-cycle flow ordering

1. Discover + manage hand-opened positions (manual behavior, unchanged).
2. Manage any bot-opened `spread_active` spreads (existing `handle_spread`).
3. **Then** auto-open: if under `max_concurrent_spreads` and not market-closed → screen universe → score → normalize → pick best symbol with `wheelability ≥ threshold`, earnings-clear, BP-fit, within risk cap → `_open_spread_mleg()`. At most one.

## Dashboard

### Register the 3 accounts

The account list is enumerated in ~8 places (the plan lists each with file:line): `useAccount.ts` (`AccountMode`), `Sidebar.tsx` (`acctOpts`), `alpaca.ts` (`credsFor`), `account-utils.ts` (`Mode`, `ALL_MODES`, `ALL_ACCOUNTS`), `trade-types.ts` (`AccountId`), `rule-check.ts` (`accountToMode`), related tests. Add `sm500`/`sm1000`/`sm2000` + `*_paper` ids + env-var branches everywhere. Vercel function count unaffected (more branches/env vars, not new functions — stays 10/12).

### Group-view selector (Tim's model)

Keep today's **per-account single select + "All"**, and **add three group chips**:

| Group chip | Accounts | Proposed label |
|---|---|---|
| Small | sm500 · sm1000 · sm2000 | `small` (chips display `$500/$1k/$2k`) |
| Core | conservative · aggressive | `core` |
| Hands-on | manual · live | `hands-on` |

Selecting a group renders those accounts **side-by-side** on the account-aware pages (Home cards, Positions, Orders, etc.). Today the selector is single-mode or `both`/all; the model generalizes to **"the currently selected set of accounts"** (1, a group, or all). Labels are decoupled from tokens (chips can show `$1,000` while the mode stays `sm1000` — same pattern as the existing `live $` chip). *(Open decision #4: confirm group names + that single/All stay.)*

## Proposed defaults — TWEAK THESE

| Param | Proposed default | Why / note |
|---|---|---|
| `screener_universe` (SM) | conservative "happy to own" pool **expanded to ~60 names** (50–100 range) | RESOLVED #5; aggressive pool deferred until accounts grow |
| `max_underlying_price` | **$25** | RESOLVED #3 — sm500-only universe filter so narrow spreads fit its risk cap; sm1000/sm2000 unfiltered |
| `wheelability_min` | **90** (percentile-normalized 0–100) | RESOLVED #1 — "top ~10% of today's screened universe" |
| `bp_switch_threshold` | **$5,000** | below → spread instead of CSP (Tim's number) |
| `short_put_otm_pct` | 0.10 | reuse manual wheel `put_strike_pct` |
| `spread_dte_min/max` | 14 / 28 | reuse manual wheel DTE |
| `target_spread_width` | smallest available ≥ $1 that fits risk cap | narrower = less risk, less credit |
| `max_risk_pct_equity` | **12%** | sm500 ≈ can't afford a $1 spread → mostly no-trades (open #3) |
| `min_net_credit` | **$0.05** /share | risk rail — reject non-credit / near-zero-credit spreads a thin chain can produce (long_mid ≥ short_mid). 0 credit pins profit_pct to 0 forever (50%-profit close can never fire); negative credit is a disguised debit spread that busts the risk cap |
| `max_concurrent_spreads` | **3** | per account; sm500 effectively 0–1 via risk cap |
| `account_floor` | **$300** equity | don't trade a near-dead account |
| `earnings_exclusion_days` | **7** | hard skip; bot gains yfinance (open #2) |
| `max_opens_per_cycle` | **1** | no burst-fill |
| cron offsets | sm500 `:05`, sm1000 `:08`, sm2000 `:06`-ending | free 10-min slots (cons :07/agg :09/manual :01/live :03 taken) |

## Architecture / file structure

**Bot (Python):**
- `config.py` — add `sm500`/`sm1000`/`sm2000` to `MODES` (manual flags + the new `auto_open_*` param block); add the SM screener-universe pointer.
- `screener_core.py` *(new)* — extracted shared scoring (`score_candidate` + universe build) imported by both `wheel_screener.py` (refactored to import it; output unchanged) and the new opener.
- `wheel_strategy.py` — new `_open_spread_mleg()`, new `_auto_open_spread()` (screen→score→normalize→guards→open), the BP-switch helper, earnings helper; wired into the per-cycle flow gated by `auto_open_spreads`.
- `requirements.txt` — add `yfinance` (+ pin) for the earnings guard.
- `tools/setup_cronjobs.py` — 3 new cron jobs (offsets above).
- `.github/workflows/` — `tsla-monitor-sm500.yml` / `-sm1000.yml` / `-sm2000.yml` (copy the manual workflow; `--mode smNNN`; SM state files; dashboard push steps).
- `daily_summary.py` — include the 3 SM accounts in the per-mode summary loop (no head-to-head — different capital base, like manual/live).

**Dashboard (TS/React):** the ~8 enumeration sites above + the group-selector UI + multi-account render generalization + tests.

**Tests:** pytest for scoring/normalization/spread-construction/guards/earnings (all Alpaca + yfinance mocked, per existing `conftest.py`); the existing mode-isolation test pattern extended to the 3 SM modes (distinct creds/state/channels, flag correctness); vitest for the dashboard group-selector logic. No live calls in tests.

## Testing strategy

- **Pure logic = strict unit tests:** score normalization (percentile), BP-switch, spread-leg selection, every risk-rail guard (risk cap, concurrency, floor, BP-fit), earnings exclusion (mocked yfinance dates). These are deterministic and are the correctness core.
- **Mode isolation:** extend the existing test that asserts each mode has distinct Alpaca creds / state files / Discord channels and correct flags — now covering sm500/1000/2000 and asserting `auto_open_spreads` fires only there (not cons/agg/manual/live).
- **Order construction:** assert `_open_spread_mleg()` builds a correct `mleg` body (STO short / BTO long, intents, ratio, limit) without calling Alpaca (mock `api_post`).
- **Dashboard:** vitest for "selected set of accounts" rendering + group chips.
- **Manual device pass:** the dashboard group selector visual is jsdom-unverifiable → Tim's phone pass, like prior efforts.

## Resolved decisions (2026-05-15, all confirmed by Tim)

1. **Score normalization:** ✅ percentile-rank the day's screened universe to 0–100, gate at `≥90` (top decile).
2. **Earnings data:** ✅ add `yfinance` to the bot.
3. **$500 reality:** ✅ tune sm500 to **cheap underlyings (≤ ~$25)** so it can still attempt small trades; risk cap never relaxed. sm1000/sm2000 unfiltered.
4. **Group selector:** ✅ keep single-select + All, add **Small / Core / Hands-on** group chips.
5. **SM universe:** ✅ conservative "happy to own" pool, **expanded to ~50–100 (target ~60) names**; aggressive pool deferred until accounts grow.
6. **Numbers:** ✅ `$5,000` BP switch, `12%` max-risk, `90` threshold accepted as the conservative starting points (all remain config-tweakable).

No open decisions remain — the companion implementation plan can be written.

## Rollout

Phased implementation plan (companion doc) written **after** you resolve the open decisions above. All-3-live from day one per your call — de-risking is the conservative defaults + guardrails + hard earnings exclusion, not a soak window. Branch `claude/small-account-auto-spread` (off `main`). Not pushed / no PR / not deployed until you say, same as the last two efforts. You handle the GitHub Actions secrets for the 3 new accounts; I'll list exactly which in the plan.
