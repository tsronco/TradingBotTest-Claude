// Hand-curated changelog. Add a new entry at the TOP every time we ship
// a real change (bot config, dashboard feature, fix, anything user-facing).
// Bot state-update commits do NOT belong here — only changes that matter
// to a human looking at "what's new."
//
// Conventions:
//   date     — YYYY-MM-DD, real ship date
//   category — feature | fix | config | engine | ui | infra
//   title    — one-liner (under ~80 chars). What changed.
//   details  — optional expansion. Why we did it / what to know. Plain text
//              or simple multi-paragraph; Changelog.tsx renders with
//              whitespace-pre-wrap. Use blank lines between paragraphs.

export type ChangelogCategory =
  | 'feature'
  | 'fix'
  | 'config'
  | 'engine'
  | 'ui'
  | 'infra';

export interface ChangelogEntry {
  date: string;
  category: ChangelogCategory;
  title: string;
  details?: string;
}

// Newest first.
export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-06-23',
    category: 'feature',
    title: 'Trade detail now shows the break-even — readout + a line on the chart',
    details:
      'Break-even used to be visible only while placing an order. The trade detail screen '
      + '(/trade/:id) now shows it after the fact too: a "break-even" readout in the header '
      + 'and a dashed cyan line on the price chart, so you can see at a glance whether price '
      + 'is above or below it. It is the fill-based break-even of the position you actually '
      + 'entered, recomputed from the stored trade with the same payoff engine the order form '
      + 'uses — so it works retroactively on every trade already in the system, with no data '
      + 'migration. Shown for stocks, options, and spreads.',
  },
  {
    date: '2026-06-23',
    category: 'fix',
    title: 'Live single-leg orders now actually place (were rejected with 40110000 "request is not authorized")',
    details:
      'Placing a stock or option order on the live (real-money) account from the dashboard failed every '
      + 'time with Alpaca error 40110000 "request is not authorized" — nothing was ever placed on live or '
      + 'paper. Root cause: the single-leg submit path was the one order route still going through '
      + '@alpacahq/typescript-sdk, which ignores `paper: false` and sends every trading request to '
      + 'paper-api.alpaca.markets. So a live order carried the live API keys to the PAPER host, and the '
      + 'paper host rejected them. (Spreads, modify, and cancel were migrated off the SDK on 2026-05-13; '
      + 'single-leg placement was missed — it still had the old "paper for now" SDK call.)\n\n'
      + 'Fix: single-leg placement now goes through alpacaTradeMutation(POST /v2/orders), the same '
      + 'direct-fetch helper the spread path already uses, which honors the live host (api.alpaca.markets). '
      + 'Paper accounts are byte-unchanged. Verified the live keys authenticate and the account is ACTIVE '
      + 'before shipping. 762 vitest green; tsc clean.',
  },
  {
    date: '2026-06-22',
    category: 'fix',
    title: 'Grade-open cron no longer 504s — fills/closes sync before grading, on a time budget',
    details:
      'A filled trade (e.g. the ARM spread) could sit on /trades showing no entry price for hours, and '
      + 'the [↻ refresh] button returned a 504. Root cause: the grade-open cron had NO wall-clock budget, '
      + 'so on a large open-trade backlog it ran the full 60s (slow AI grades first) and got killed by '
      + "Vercel before the cheap fill-sync ran — leaving fresh fills stuck \"submitted.\"\n\n"
      + 'Three fixes:\n'
      + '1) The run now self-limits to ~45s and RETURNS cleanly (work done is saved, the rest carries to the '
      + 'next tick) instead of being killed → no more 504, including on the refresh button.\n'
      + '2) Reordered so cheap fill-sync + close-detection runs BEFORE AI grading (grading can no longer '
      + 'starve sync). Grading still runs every tick with the leftover budget and drains the backlog over a '
      + 'few ticks — nothing is skipped, it just spreads across ticks (the 60s serverless limit makes '
      + '"grade everything in one shot" impossible).\n'
      + '3) New stock external-close detection: a stock you sold on Alpaca that previously sat "open" forever '
      + '(bloating the index) now closes automatically in the unambiguous case (position gone + exact-qty '
      + 'sell fill). Partial/multi-lot sells are left for manual review to avoid mis-booking P&L.\n\n'
      + 'Net effect: the bloated "open" count drains on its own, new fills sync within a tick or two, and '
      + 'grading keeps up automatically.',
  },
  {
    date: '2026-06-22',
    category: 'feature',
    title: 'New rule: warns when a short put is sold too close to the money (<7% OTM)',
    details:
      'A built-in warn-severity rule check (short_put_too_close_otm) now fires on the order confirm modal '
      + 'whenever a short put — either a bare cash-secured put (STO) or the short leg of a put credit spread — '
      + 'has its strike less than 7% below the current stock price. Built to curb the "chase premium close to '
      + 'the money and blow past the strike" tendency: going further OTM trades a little premium for a much '
      + 'higher win rate.\n\n'
      + 'Example that prompted it: an ARM $390/$350 put credit spread with ARM at ~$413.79 — the short $390 '
      + 'strike was only ~5.75% OTM. That trade now surfaces an amber warning at review.\n\n'
      + 'Warn-only (one-click override; sometimes going closer is deliberate). The underlying spot price is '
      + 'now threaded through the preview/check/submit paths so the rule can measure OTM distance. Fires on all '
      + 'accounts; the bot already opens its own puts ~10% OTM, so this mainly guards hand-placed manual trades.',
  },
  {
    date: '2026-06-20',
    category: 'ui',
    title: 'Account cards show the real Alpaca account number (was a fake 10.0.0.x IP)',
    details:
      'Each account card header carried a hardcoded fake LAN IP (10.0.0.1, etc.) as retro decoration. '
      + 'Swapped it for the live `account_number` straight off the existing /api/alpaca/account response '
      + '(it was already in the payload, just unused) — so cards now read the real PA3XVDT9K3SI / 243597269 '
      + '/ etc. Always correct, auto-covers every account, and nothing to maintain when accounts are added '
      + 'or sunset. The fake-IP map is gone.',
  },
  {
    date: '2026-06-20',
    category: 'ui',
    title: 'Header NET / API are now live — real latency + a red API ERR when data is down',
    details:
      'The `NET 42ms` and `API OK` readouts were hardcoded. They are now real: a lightweight ping to\n'
      + '/api/alpaca/clock (auth-protected, full path: dashboard API → Alpaca → back) every 30s measures\n'
      + 'the round trip and shows it as NET (green, amber over 300ms, red on failure). API reads OK while\n'
      + 'that ping succeeds and flips to a red ERR the instant it fails — so a broken feed (Alpaca down,\n'
      + 'auth expired, a function erroring) is visible at a glance instead of surfacing as a mysteriously\n'
      + 'empty page. No new Vercel function — reuses the existing clock endpoint (still 10/12).',
  },
  {
    date: '2026-06-20',
    category: 'ui',
    title: 'Live version in the header + sidebar — major.bot.dashboard (now 0.3.22)',
    details:
      'The old `BUILD 0.4.2` was a hardcoded literal that never moved. It now reads a real version from\n'
      + 'one source (src/build-version.ts), shown in both the top-bar BUILD pill and the sidebar, in the\n'
      + 'format major.bot.dashboard:\n'
      + '  • major 0 = pre-live (bumps to 1 the day we go live)\n'
      + '  • the middle digit ticks on real BOT changes\n'
      + '  • the last digit ticks on real DASHBOARD changes\n'
      + 'so a glance tells you which side a release touched. The ~10-minute bot state pushes never count.\n'
      + '`npm run bump` auto-picks the segment(s) from what changed at ship time. Seeded from project\n'
      + 'history (313 bot / 224 dashboard real commits) to a clean 0.3.22 — and this change itself ticked\n'
      + 'the dashboard digit, proving the tooling works.',
  },
  {
    date: '2026-06-20',
    category: 'fix',
    title: 'Market-status pill: the reason now shows on mobile tap (was desktop-hover only)',
    details:
      'The OPEN/CLOSED pill surfaced its reason via a native HTML `title` tooltip, which only appears on '
      + 'desktop hover — tapping it on a phone did nothing. The pill is now a button that toggles a real '
      + 'popover on tap (closing on an outside tap or Escape), so the reason (Regular session / Weekend / '
      + 'holiday / Pre-market / After hours) is reachable on mobile. The popover renders in a portal so it '
      + 'sits above the sticky header and the scrolling watchlist ticker instead of being clipped behind '
      + 'them. Desktop hover is unchanged — the `title` '
      + 'is retained for instant hover feedback. Frontend-only; +2 AppShell tests.',
  },
  {
    date: '2026-06-20',
    category: 'ui',
    title: 'Header now shows the ET date and a live market OPEN/CLOSED pill',
    details:
      'The top bar previously showed only the time. It now shows the Eastern-Time date (e.g. "Fri Jun 20") '
      + 'and a green OPEN / red CLOSED pill next to the clock. The pill accounts for the time of day in ET, '
      + 'the day of the week (closed Sat/Sun), full-closure holidays (with NYSE observed-date shifts), and '
      + 'half-days — a half-day reads "OPEN · ½ day" until the 1:00 PM ET early close.\n\n'
      + 'Hovering (or tapping) the pill shows the reason: Regular session, Weekend, the holiday name '
      + '(e.g. Juneteenth), Pre-market, or After hours.\n\n'
      + 'Source of truth is Alpaca\'s /clock endpoint (the same one the bot trusts — it natively handles '
      + 'holidays, half-days, and rare ad-hoc closures), surfaced through the existing alpaca/[endpoint].ts '
      + 'catchall so no new Vercel function is consumed. A self-contained NYSE calendar (src/lib/market-status.ts) '
      + 'computes the same answer locally as an instant, offline-capable baseline for the installed PWA, and '
      + 'fills the gap if the clock fetch fails.',
  },
  {
    date: '2026-06-19',
    category: 'config',
    title: 'Manual bot: excluded SNAP so it stops covering/managing the underwater 100 shares',
    details:
      'SNAP was assigned (100 shares) and is severely underwater. A pending covered call is being\n' +
      'cancelled, and on the next cycle the manual bot would have auto-discovered the shares and sold\n' +
      'ANOTHER covered call (handle_stage2 → _sell_new_call) — re-locking the shares so they could not\n' +
      'be sold by hand. strategy.py would also have started trail/ladder/stop on them (the ladder buys\n' +
      'MORE shares on the way down — the opposite of getting out).\n\n' +
      'Added a new manual-mode config key `excluded_symbols: ["SNAP"]` plus a `config.excluded_symbols()`\n' +
      'helper. Both wheel_strategy.py (discovery filter) and strategy.py (held filter) now skip any listed\n' +
      'symbol entirely: no covered-call sale, no put management, no trail/ladder/stop. The position stays\n' +
      'in Alpaca; the bot just leaves it alone so the user can close the 100 shares manually.\n\n' +
      'Default is an empty set, so conservative/aggressive/live/SM are byte-unaffected. Remove SNAP from\n' +
      'the list (config.py, manual mode) once the shares are sold to hand it back to the bot.',
  },
  {
    date: '2026-06-18',
    category: 'fix',
    title: 'One-time data correction: fixed 14 mis-booked manual spreads (removed ~$2,841 P&L overstatement)',
    details:
      'Audited all 25 manual put-credit spreads against the Alpaca activity log (the companion cleanup to\n' +
      'the detectClose code fix shipped earlier today). Found:\n' +
      '  • 12 records booked as fabricated worthless-expiry WINS when the bot had actually closed them\n' +
      '    earlier (e.g. MU 1035/1010 showed +$950, real close was -$185; MU 755/745 showed +$140, real\n' +
      '    -$660; INTC 118/113 showed +$150, real -$265).\n' +
      '  • 2 spreads stuck "open" despite real closes (NVDA 212/207.5 real +$101; PINS 20.5/19.5 real -$29).\n' +
      '  • 1 duplicate (QQQ 724/712 double-recorded by the auto-importer).\n\n' +
      'Each was corrected to its real close P&L (closed_by bot_external, realized_pnl / closed_avg_price /\n' +
      'closed_at from the actual leg fills), the duplicate was deleted, and all 13 were re-queued for AI\n' +
      're-grade against the true outcomes. Method validated: for all 8 spreads the dashboard had ALREADY\n' +
      'booked correctly, the independent recompute matched the stored P&L to the penny.\n\n' +
      'Bottom line: the manual spread book was being shown as roughly breakeven-positive; its true realized\n' +
      'P&L is -$1,068. The strategy has been losing money — the phantom max-profit bookings were hiding it.',
  },
  {
    date: '2026-06-18',
    category: 'fix',
    title: 'Spread P&L integrity: a bot-closed spread no longer mis-books as a fabricated expiry win',
    details:
      'Found while reconciling a manual MU put-credit spread: the dashboard showed it +$950\n' +
      '"expired worthless" when Alpaca\'s activity log proved the bot had tripwire-closed it on\n' +
      '06-16 for a -$185 LOSS. Root cause in detectClose (api/cron/[job].ts): Path 2b (spread\n' +
      'past-expiration) fabricates a settlement from current spot vs strikes and ran BEFORE Path 3\n' +
      '(real external-close detection). When the bot closes a spread before expiry but the cron only\n' +
      'resolves it after the expiration date passes, Path 2b saw spot above the short strike and\n' +
      'booked the full credit as a win — steamrolling the real close. (The single-option Path 2 was\n' +
      'already hardened against this exact "fabricate a win" mistake under D11; its spread cousin was\n' +
      'not.) The interaction is nasty: the 06-16 tripwire fix forces bot closes into the <=2-DTE\n' +
      'window — exactly where this strikes — so it would mis-book MORE trades over time, corrupting\n' +
      'realized P&L, win rate, and AI calibration.\n\n' +
      'Fix: detectExternalSpreadClose now runs ahead of the Path 2b fabrication (a real close is\n' +
      'ground truth; it returns null on genuine expiries with no closing fills, so real expiries\n' +
      'still settle via Path 2b). +1 regression test (MU scenario: closed -$185 on 06-16, resolved\n' +
      'after the 06-18 expiry with spot above the short strike -> books bot_external -$185, never the\n' +
      '+$950 fabrication). 738 vitest green. A one-time audit + correction of already-mis-booked\n' +
      'records follows separately.',
  },
  {
    date: '2026-06-18',
    category: 'feature',
    title: 'Trades table — sortable column headers + defaults to the manual paper filter',
    details:
      'Click any header on /trades to sort by that column; click again to flip direction (▲/▼).\n' +
      'Date, symbol, side, qty, entry, exit, P&L, grade, AI grade, and tags are all sortable. Open\n' +
      'trades with no exit or realized P&L always sort to the bottom, whichever direction you pick.\n\n' +
      'Sorting runs client-side over the rows currently loaded, so set SHOW to "all" if you want it\n' +
      'to order the whole ledger rather than just the visible page.\n\n' +
      'The account filter now defaults to manual_paper instead of "all" — that\'s the hand-managed\n' +
      'account we look at most. Switch it back to [any] or another account anytime. Sort logic lives\n' +
      'in src/lib/trade-sort.ts (pure, unit-tested); the table sorts trade+grade pairs together so the\n' +
      'AI-grade column can never desync from its row.',
  },
  {
    date: '2026-06-18',
    category: 'fix',
    title: 'Fix two TypeScript errors in the trades submit endpoint (idempotency dedup)',
    details:
      'api/trades/[action].ts threw two TS2339 "Property \'trade\' does not exist" errors on every\n' +
      'Vercel build. claimIdemIndex returns a discriminated union ({winner:true,id} |\n' +
      '{winner:false,id,trade}); under strict mode `if (!idemClaim.winner)` narrows it correctly,\n' +
      'which is why local `tsc -b` passed. But api/ sits outside the local tsc project graph, and\n' +
      'Vercel\'s @vercel/node compiles those functions with default (non-strict) options where that\n' +
      'narrowing does not apply — so the build flagged the .trade access. Fix: name the union\n' +
      '(IdemClaim) and assert the loser branch explicitly (idemClaim as ExistingClaim) at both call\n' +
      'sites, justified by the !winner guard right above. Runtime behavior unchanged — purely a\n' +
      'type-safety / clean-build fix.',
  },
  {
    date: '2026-06-18',
    category: 'feature',
    title: 'Trade detail: "delete trade" action for cleaning up duplicates / bad imports',
    details:
      'New DANGER panel on /trade/:id with a two-step [delete trade] → [confirm delete]. Wires\n' +
      'POST /api/trades?action=delete, which scrubs the id from the open index, its month index,\n' +
      'and the needs-grade queue, then drops the trade + grade records. Removes the trade from\n' +
      'P&L / win-rate / calibration aggregates; does NOT touch Alpaca. Built to clear the QQQ\n' +
      'duplicate (the dashboard-placed spread + its auto-import twin both closing at +$249, which\n' +
      'double-counted the win). Also: drainNeedsGrade now skips a queued trade that already has a\n' +
      'hindsight grade (e.g. graded via the "grade now" button) instead of re-grading it.\n' +
      'Tests: +4 vitest (delete index/record scrub, needs-grade removal, 404, malformed id). 722 green.',
  },
  {
    date: '2026-06-18',
    category: 'feature',
    title: 'Trades page: "drain backlog" button clears the whole open backlog in one click',
    details:
      'After the cron-cap fix, clearing a large existing backlog (~300 stuck-open trades) still\n' +
      'meant clicking [↻ refresh] many times (30 trades/click). Added a second button, [drain\n' +
      'backlog], that runs the lifecycle sweep with no per-tick cap and a ~45s soft wall-clock\n' +
      'budget — so it processes as many trades as fit in one request without risking a 504, then\n' +
      'a follow-up click resumes from the rotating cursor. AI grading is deferred entirely to the\n' +
      'needs-grade queue during a drain so closes land fast; the cron fills in hindsight grades\n' +
      'later. Wiring: runGradeOpenTrades({ sweepBudget, gradeBudget, timeBudgetMs }) opts +\n' +
      'POST /api/trades/refresh?mode=drain. Normal [↻ refresh] (30/tick, inline grading) unchanged.\n' +
      'Tests: +4 vitest (drain no-cap+queue, time-budget halt, endpoint opts, drain button). 718 green.',
  },
  {
    date: '2026-06-18',
    category: 'fix',
    title: 'Grade-cron no longer caps at 3/tick or times out — drains the whole open backlog',
    details:
      'Two coupled problems on the trade-lifecycle cron (api/cron/[job].ts), surfaced by a\n' +
      '~310-trade open backlog and a 504 on the aggressive account:\n\n' +
      '1. MAX_PER_TICK=3 broke the ENTIRE sweep after 3 closes — and fill-sync + close\n' +
      '   detection ran inside that same loop, always starting at index 0. So with a big\n' +
      '   open index the tail (newest trades, e.g. the stuck QQQ spreads) was never synced or\n' +
      '   close-detected. Fix: the cap now applies ONLY to AI grading (the lone expensive\n' +
      '   step). Fill-sync + close-detection run for every swept trade.\n\n' +
      '2. With nothing closing early, the old loop walked all ~310 open trades doing Alpaca\n' +
      '   reads each — over the Vercel 10s default function limit → 504. Fixes:\n' +
      '   • Rotating sweep cursor (trades:cursor:sweep) processes up to SWEEP_BUDGET=30\n' +
      '     trades/tick, wrapping, so the full index is covered over ~10 ticks (~50 min) with\n' +
      '     bounded per-tick work.\n' +
      '   • maxDuration raised to 60s (vercel.json functions config) for headroom.\n' +
      '   • AI grading budgeted at 5/tick; closes beyond budget are still recorded immediately\n' +
      '     (exit + P&L visible) and their hindsight letter is deferred via a needs-grade queue\n' +
      '     (trades:index:needs_grade) drained on later ticks.\n\n' +
      'Net: every open trade gets fill-synced + close-detected within a few ticks, closes show\n' +
      'up promptly, and the function no longer times out on a large backlog.\n' +
      'Tests: +4 vitest (8-close tick, grade budget+queue, queue drain, cursor wrap). 714 green.',
  },
  {
    date: '2026-06-18',
    category: 'fix',
    title: 'Spread fills now sync (nested=true) + imports confirm immediately — stuck "submitted" spreads heal',
    details:
      'Dashboard-placed multi-leg (mleg) spreads were stuck at "submitted" with a "—"\n' +
      'fill forever, and their bot-closes were never picked up. Root cause: syncFillData\n' +
      'fetched the parent mleg order without `?nested=true`, so Alpaca returned it with no\n' +
      '`legs` array — the leg match failed and filled_at was never written. Since the record\n' +
      'never looked "filled," external-close detection could not touch it either.\n\n' +
      'Fixes (api/cron/[job].ts, api/trades/[action].ts):\n' +
      '1. fetchOrderById now passes nested=true so the mleg parent rolls up its legs.\n' +
      '2. Belt-and-suspenders fallback: if a filled mleg order still returns no usable legs,\n' +
      '   syncFillData reads each leg\'s opening fill from the /v2/account/activities FILL\n' +
      '   stream instead of giving up.\n' +
      '3. syncFillData now records each leg\'s Alpaca order id onto spread.short_leg.order_id /\n' +
      '   long_leg.order_id, so a later Import dedups against a dashboard-placed spread\n' +
      '   (orderIdAlreadyImported already checked that field — it was just never populated)\n' +
      '   instead of creating a duplicate record.\n' +
      '4. Imported records (spread + single option) are stamped fill_confirmed:true — they\n' +
      '   come straight from a FILL activity, so the D14 close guard no longer defers their\n' +
      '   bot-close for up to 24h.\n\n' +
      'Self-healing: once deployed, the grade-open-trades cron re-syncs every still-open\n' +
      'spread on its next tick — previously-stuck records pick up their fill (and then their\n' +
      'close, if the bot already closed them) with no manual intervention.\n\n' +
      'Tests: +5 vitest (2 cron sync/fallback, 3 import fill_confirmed + leg-id dedup). 710 green.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D15: import dedup — client-side timestamp filter prevents pre-cursor fills re-importing',
    details:
      'D15 money-loss remediation (low severity). Alpaca\'s `after` param on\n' +
      '/v2/account/activities is DATE-granular (YYYY-MM-DD only), so it re-offers\n' +
      'all fills from the cursor date regardless of time. Without a client-side\n' +
      'guard, fills that happened earlier in the same day than the `since` cursor\n' +
      'could be imported as duplicate trade records, inflating win count and total\n' +
      'realized P&L on /performance.\n\n' +
      'Fix: after fetching the Alpaca activity page, any fill whose precise\n' +
      'transaction_time is <= the full ISO `since` cursor is dropped before it\n' +
      'reaches the dedup or opening-fill logic. Fills with a missing/unparseable\n' +
      'timestamp are kept (safe default — must not silently drop genuine opens).\n\n' +
      'Location: dashboard/api/trades/[action].ts runImport(), new `afterSince`\n' +
      'filter block after activity pagination.\n' +
      'Tests: 2 new vitest tests in tests/api/trades-import.test.ts (D15 suite).',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D12: debit-spread close P&L sign corrected for external close and expiry',
    details:
      'D12 money-loss remediation (medium severity). Two code sites in api/cron/[job].ts\n' +
      'assumed credit-spread math for ALL spread types:\n\n' +
      '1. detectExternalSpreadClose: used (net_credit − netDebitToClose) × 100 × qty. For\n' +
      '   debit spreads net_credit=0, so a $150 winner (debit spread sold back above cost)\n' +
      '   booked as e.g. −$70. Fixed: branched on isCreditSpread(). Credit formula unchanged;\n' +
      '   debit formula: (longPx − shortPx − net_debit) × 100 × qty.\n\n' +
      '2. Path 2b expiry geometry: "OTM → keep net_credit" and "ITM → full max_loss" were\n' +
      '   both correct for credit spreads but wrong for debit spreads (direction inverted).\n' +
      '   Fixed: added debit branch. put_debit max profit when spot < short.strike (both\n' +
      '   puts ITM); call_debit max profit when spot >= short.strike (both calls ITM). Max\n' +
      '   loss in each case is −net_debit × 100 × qty (debit fully lost).\n\n' +
      '10 new vitest tests covering all four spread types in external-close and expiry paths,\n' +
      'plus credit-spread regression guards. Full suite: 702/702.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D9: short-call exposure now uses assignment notional, not premium',
    details:
      'D9 money-loss remediation (medium severity). Previously, computeExposure\n' +
      '(api/_lib/exposure.ts) used strike × qty × 100 for STO puts (correct collateral)\n' +
      'but fell through to qty × premium × 100 for STO calls — the tiny premium amount\n' +
      '(e.g. $210 on a $350 strike at $2.10) sailed under every TOTP threshold including\n' +
      'the live account\'s $1,500 gate. The recorded exposure_at_submit was also wrong\n' +
      'for risk review.\n\n' +
      'Fix: added an STO-call branch that mirrors STO-put exactly:\n' +
      '  exposure = strike × qty × 100\n' +
      'This is the shares-called-away notional — the same conservative proxy the\n' +
      'OptionOrderForm.tsx client preview has always used (strike × 100 × qty for all\n' +
      'STO opens). A naked call\'s true risk is unbounded, but strike-notional is the\n' +
      'agreed proxy; it is always large enough to trigger TOTP on real-money short calls.\n\n' +
      '3 new/updated vitest tests: STO-call yields strike-notional (not premium),\n' +
      'scales with qty, and the corrected value exceeds the live $1,500 threshold while\n' +
      'the old premium value did not. STO-put, BTO, BTC, STC, stock, and spread branches\n' +
      'are all regression-guarded. Full suite: 692/692.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D10: session tokens now expire server-side after 30 days',
    details:
      'D10 money-loss remediation (medium severity). Previously, decodeSession verified\n' +
      'the HMAC signature but never checked the session age — a validly-signed cookie\n' +
      'was accepted indefinitely. A copied or stolen session (browser export, device\n' +
      'access, leaked log) granted permanent order-placement access.\n\n' +
      'Fix: after HMAC verification, decodeSession now computes\n' +
      '  age = Date.now() / 1000 − session.loggedInAt\n' +
      'and returns null when age > MAX_AGE_SECONDS (30 days). The boundary is strict\n' +
      '(>), so a token aged exactly 30 days is still valid. Session creation is\n' +
      'unchanged — only decoding is affected.\n\n' +
      '6 new vitest tests: expired → null, fresh → passes, exactly-at-boundary →\n' +
      'passes, one-second-over → null, bad-signature-expired → null, missing-secret\n' +
      'fresh → null. Full suite: 690/690.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D8: login rate-limit hardened — rightmost XFF + global failure backstop',
    details:
      'D8 money-loss remediation (high severity). The old clientIp() took the LEFTMOST\n' +
      'token of x-forwarded-for, which a client can forge freely. Rotating the leftmost\n' +
      'value per request made every attempt look like a new IP, so the 5-fails/15-min\n' +
      'lockout never tripped — unthrottled brute-force on DASHBOARD_PASSWORD + TOTP.\n\n' +
      'Fix 1 — Trusted header: switched to the RIGHTMOST token of x-forwarded-for.\n' +
      'Vercel docs confirm Vercel rewrites this header entirely ("does not forward external\n' +
      'IPs — this restriction is in place to prevent IP spoofing"), so on vanilla Vercel\n' +
      'there is exactly one token and rightmost == the real client IP. Under a proxy chain\n' +
      'the rightmost is the nearest trusted-proxy-added hop, which a client cannot prepend to.\n\n' +
      'Fix 2 — Global backstop (auth:fail:global): every failed login, regardless of IP,\n' +
      'increments a global counter (same 15-min sliding window). After 20 global failures\n' +
      'all login attempts are locked out for 15 min, even from fresh IPs. Completely defeats\n' +
      'IP-rotation spoofing. The threshold (20 / 15 min) is deliberately loose enough that\n' +
      'a fat-fingered legitimate user does not get locked out, but tight enough to stop\n' +
      'any automated brute-force campaign.\n\n' +
      'Fix 3 — clearFailures now deletes both the per-IP key and the global key on\n' +
      'successful login, so neither counter bleeds into a new session.\n\n' +
      '13 new vitest tests (12 in rate-limit.test.ts, 1 in auth-login.test.ts).',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D3: backup-code single-use guarantee made atomic via Redis SADD',
    details:
      'D3 money-loss remediation (high severity). The old consumeBackupCodeIfValid used a\n' +
      'read-modify-write: get the used-codes array, check if the hash is present, push it,\n' +
      'set the array back. Two concurrent login attempts with the same backup code could both\n' +
      'read the array before either wrote, both see the code absent, and both succeed — breaking\n' +
      'the single-use guarantee.\n\n' +
      'Fix: replaced with a single atomic Redis SADD on a new SET key (auth:used-backup-codes:v2).\n' +
      'SADD returns 1 if the member was newly added (first use → accept) or 0 if already present\n' +
      '(previously consumed or concurrent duplicate → reject). One Redis round-trip, no race window.\n\n' +
      'Migration: the old JSON-array key (auth:used-backup-codes) is still checked read-only\n' +
      'during the transition window so codes marked used under the old scheme stay rejected.\n' +
      'Code rotation (regenerateBackupCodes) deletes both keys so new codes start clean.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D14: spread close no longer books P&L from stale target mid when entry fill is unconfirmed',
    details:
      'D14 money-loss remediation (low severity). On legacy pre-D7 spread trades that had\n' +
      'filled_at set and non-empty modify_history, syncFillData hit its legacy short-circuit\n' +
      'and returned without re-syncing the real fill credit. If detectExternalSpreadClose ran\n' +
      'on the same tick, it computed realized P&L from the stale decision-time mid (net_credit)\n' +
      'rather than the actual fill price — a minor but real P&L inaccuracy on /trades.\n\n' +
      'Fix: detectExternalSpreadClose now checks fill_confirmed before computing P&L.\n' +
      'If fill_confirmed is absent/false, the close is deferred (return null) so the next\n' +
      'cron tick\'s syncFillData can confirm the real entry credit first.\n' +
      'A 24h backstop prevents indefinite deferral: past that window the close is booked\n' +
      'with whatever net_credit is stored and a [D14] console.warn notes the approximation.\n\n' +
      'In the common path (all post-D7 trades), fill_confirmed is set alongside filled_at\n' +
      'and net_credit atomically — so detectExternalSpreadClose proceeds immediately with\n' +
      'the correct value and the defer never fires.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D11: past-expiry STO backstop no longer fabricates an expired-worthless win without confirming settlement',
    details:
      'D11 money-loss remediation. When Alpaca\'s OPEXP/OPASN settlement activity didn\'t post within\n' +
      'the 3-day backstop window, the cron silently booked the short option as "expired worthless"\n' +
      '(full premium kept = a win) regardless of whether it was actually assigned. If the contract\n' +
      'was ITM and assigned, the 100 delivered shares had no trade record and were invisible to\n' +
      'exposure and P&L. Additionally, a null filled_avg_price produced realized_pnl=0 (misleading\n' +
      'breakeven) instead of the real premium.\n\n' +
      'Fix: conservative backstop posture. When settlement is unconfirmed past the backstop:\n' +
      '(1) Null filled_avg_price → leave trade open + log [D11] warning (no silent P&L=0 booking).\n' +
      '(2) Cross-check /v2/positions/{underlying} for assignment evidence. If the position has\n' +
      '    qty ≥ 100 × contracts, book \'assigned\' so the spawn fires and the delivered shares get\n' +
      '    a trade record. If no position (404) or insufficient qty, leave the trade OPEN and log\n' +
      '    a visible warning rather than fabricating a win.\n\n' +
      'The confirmed-settlement path (OPEXP/OPASN activity present) is completely unchanged.\n\n' +
      'Known limitation: the position check cannot distinguish freshly-assigned shares from\n' +
      'pre-existing ones the user already held. Accepted tradeoff — a false-positive \'assigned\'\n' +
      'creates a visible spawned stock trade the user can delete; a false-negative \'expired\'\n' +
      'would create invisible real equity with a wrong P&L entry.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D13: findClosingFill now paginates up to 10 pages — closing fills beyond first 100 activities no longer missed',
    details:
      'D13 money-loss remediation. The close-detection cron (Path 3) previously fetched only the\n' +
      'first 100 FILL activities from Alpaca when scanning for a contract\'s closing fill. On busy\n' +
      'wheel accounts (10 symbols, multiple positions) 100 fills in a single day is reachable; if\n' +
      'the matching BTC/STC fill was the 101st activity the trade was left permanently open and\n' +
      'realized P&L was never recorded.\n\n' +
      'Fix: findClosingFill now walks up to 10 pages of 100 activities each (1 000 activities\n' +
      'total), advancing via Alpaca\'s page_token cursor (the id of the last item on each page).\n' +
      'Returns as soon as the matching fill is found. Stops early when a page returns fewer than\n' +
      '100 items (end of stream). If the 10-page cap is reached without a match, a log line\n' +
      '"findClosingFill page cap reached" is emitted in Vercel function logs so the miss is\n' +
      'visible rather than silently dropped.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D7: fill_confirmed sentinel stops redundant Alpaca fetches; sync errors no longer block close detection',
    details:
      'Two coupled problems fixed — D7 high-severity money-loss remediation.\n\n' +
      '1. Redundant fetches: the old syncFillData early-exit required modify_history.length > 0, ' +
      'so filled-but-never-modified trades (the common case) triggered an Alpaca order fetch on ' +
      'every 5-min cron tick for their entire open life — 10–70 wasted calls/tick across 7 accounts ' +
      'under load. Fix: new fill_confirmed:true sentinel written once when a fill is first confirmed ' +
      '(both the spread/mleg path and single-leg path). Subsequent ticks early-return before any ' +
      'network call. Legacy trades without the sentinel fall through and confirm once, then are free.\n\n' +
      '2. Close-detection isolation: a transient sync failure (Alpaca 429, network blip) inside ' +
      'syncFillData must never prevent detectClose from running for that trade. The per-trade ' +
      'processing loop now wraps syncFillData in try/catch so an unexpected throw skips the sync ' +
      'step but proceeds to detectClose — a real bot-closed live trade gets its P&L recorded ' +
      'regardless of the sync error.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D6: spread syncFillData now walks the Alpaca modify-chain to the terminal order',
    details:
      'A user modifying a spread\'s limit price on Alpaca\'s web UI causes Alpaca to cancel the ' +
      'original mleg order (status=\'replaced\') and create a successor linked via replaced_by. ' +
      'The dashboard\'s trade record still pointed at the original order. syncFillData fetched it, ' +
      'saw status:\'replaced\' (not \'filled\'), and returned without writing fill data — the trade ' +
      'stayed filled_at:null forever, detectClose Path 0 saw an unfilled order and left it open, ' +
      'and realized P&L / grading never fired. On live this is a real money-tracking gap.\n\n' +
      'Fix: extracted fetchOrderById + walkToTerminal helpers (shared by both the spread and ' +
      'single-leg paths). The spread branch now follows the replaced_by chain to the terminal ' +
      'order before reading fill status, repoints alpaca_order_id to the terminal, and writes ' +
      'leg fill prices / net_credit exactly as before. Iteration cap of 10 hops plus a cycle ' +
      'guard prevent infinite loops on malformed Alpaca chains. The single-leg path now uses ' +
      'the same shared helpers (removing a redundant inline fetchOrder closure).',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D5: closing fills (BTC/STC) no longer imported as phantom open trades',
    details:
      'The importer classified every buy fill as a BTO open and every sell fill as an STO open, ' +
      'because Alpaca\'s `side` field does not distinguish opening from closing. A buy-to-close ' +
      'of a short option arrived as side:\'buy\' and was treated as a new BTO open — phantom trade ' +
      'record added to trades:index:open, then immediately "closed" by the next cron tick with ' +
      'fabricated P&L when detectClose saw the position already gone.\n\n' +
      'Fix: filter activities using Alpaca\'s `position_effect` field (\'opening\' / \'closing\') ' +
      'before spread-pairing and singles classification. Only \'opening\' fills are imported; ' +
      '\'closing\' fills are skipped entirely — closes are picked up by the existing cron ' +
      'external-close detection on the original opening trade. Fills with no position_effect ' +
      '(legacy records) default to opening so no legitimate open is silently dropped.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D4: month-index converted to Redis list — concurrent appends can no longer lose a trade',
    details:
      'The per-month trade index (trades:index:YYYY-MM) was written with a read-modify-write ' +
      'get/set pattern. Two concurrent writers (a browser submit racing the 5-min auto-import ' +
      'cron, or two tabs) both read before either wrote → one appended trade id was silently ' +
      'overwritten. The trade record survived but vanished from /trades, /calendar, /performance, ' +
      'and the tendency cron: its P&L dropped from every rollup and it was never AI-graded.\n\n' +
      'Fix: readMonthIndex() and appendMonthIndex() helpers in api/_lib/kv-keys.ts now use ' +
      'atomic lrange/rpush (mirroring the open index). Legacy JSON-array string keys are ' +
      'migrated in-place on first touch (lrange throws WRONGTYPE → read+del+rpush). All 6 ' +
      'writer call sites and all 5 reader call sites in trades/[action].ts, cron/[job].ts, ' +
      'and rule-check.ts updated. 9 new vitest tests cover concurrent-append survival and ' +
      'legacy-key migration.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'D2 residual: KV idempotency index closes trade-record dedup gap on retry',
    details:
      'Follow-up to the D2 idempotency-key fix. The prior fix prevented double-placing a ' +
      'second Alpaca order on a cross-request retry (via the 422 duplicate-client_order_id ' +
      'backstop), but it still created a second trade RECORD: request 2 allocated T-2, hit ' +
      'Alpaca\'s 422, resolved the existing order, and wrote a phantom T-2 record → ' +
      'double-counted P&L.\n\n' +
      'Fix: KV idempotency index (trades:idem:<key> → trade id, 7-day TTL, nx: true ' +
      'atomicity). At the start of submit and submitSpread, before allocateTradeId() or any ' +
      'Alpaca call, claimIdemIndex() checks the index:\n' +
      '  • Index miss → allocate id, claim with nx:true, proceed normally.\n' +
      '  • Index hit (fast path) or nx claim lost (race path) → load the existing trade ' +
      '    record and return it immediately. No second allocateTradeId(), no Alpaca call, ' +
      '    no second KV write.\n\n' +
      'The Alpaca-422 backstop is kept as a secondary guard for orders placed outside this ' +
      'flow (e.g. bot-opened, import path). The dash-<id> fallback for callers without a ' +
      'stable key is explicitly documented as NOT cross-request idempotent — only a ' +
      'caller-supplied stable key (generated once in ConfirmModal useRef) qualifies.\n\n' +
      '2 new vitest tests prove the cross-request dedup: two sequential submit calls with ' +
      'the same idempotency_key → exactly one trade record, Alpaca called exactly once. ' +
      'Full suite: 14 pre-existing failures only, zero new.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'Idempotency key on all order submits — prevents double-place on retry (D2)',
    details:
      'Money-loss remediation finding D2. No order path previously sent a client_order_id ' +
      'to Alpaca. If the HTTP response was lost (network blip, Vercel cold-start, mobile ' +
      'handoff), api() threw, the confirm button re-enabled, and a re-click sent a ' +
      'byte-identical POST — two real fills on the live account once placement is enabled.\n\n' +
      'Two-layer fix mirrors the Python bot\'s R1 pattern:\n' +
      'A. Server (api/trades/[action].ts): pre-allocate the trade id before hitting Alpaca, ' +
      'derive client_order_id from the caller-supplied idempotency_key (or fallback "dash-<id>"), ' +
      'stamp it on createOrder (stock/option) and the mleg alpacaBody (spread). On a 422 ' +
      'duplicate-id rejection, resolve the already-created order via ' +
      'GET /v2/orders:by_client_order_id and proceed — one trade record, no error surfaced.\n' +
      'B. Client (ConfirmModal.tsx): generate one UUID in a useRef at modal-mount so the key ' +
      'is stable across re-renders and re-clicks. Disable the confirm button synchronously ' +
      'as the first statement in place() before any await (belt-and-suspenders). ' +
      'Include idempotency_key in every submit payload.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'Gate live order modify/cancel behind LIVE_ENABLED only (D1 — writes only)',
    details:
      'Money-loss remediation finding D1. The modify-order and cancel-order endpoints ' +
      'had no LIVE_ENABLED gate — an authenticated session could re-price or cancel a ' +
      'real resting live order while live was nominally "disabled." Added a shared ' +
      'liveGuard() helper to api/_lib/alpaca.ts and wired it inside the modify-order ' +
      'and cancel-order branches only. GET read endpoints (account/positions/orders/' +
      'equity-history) are intentionally left ungated so live monitoring keeps working ' +
      'without enabling live trading; read exposure accepted as Low risk (single-user, ' +
      'read-only). Mirrors the exact semantics of the existing submit guard in ' +
      'trades/[action].ts. 13 new vitest tests; total 626 / 92 files.',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'Phase 3 wrap: incomplete-state guard (R27) + closed out the low-severity tail',
    details:
      'Completes the 2026-06-16 money-loss remediation (34 findings). R27: ' +
      'strategy.run_one_cycle now skips a cycle with a warning when the state ' +
      'file is missing avg_cost/entry_price, instead of raising KeyError and ' +
      'crashing into #errors every tick. The remaining low-severity findings ' +
      'were reviewed and consciously closed without code changes (documented in ' +
      'the plan): R24 (STO mid pricing — a premium-vs-fill tradeoff, BP not ' +
      'constrained on the $100k accounts), R26 (TSLA-hardcoded cycle — tracked ' +
      'multi-stock refactor, latent), R28 (off-grid strike rounding — corrected ' +
      'downstream by find_best_contract), R29 (duplicate adoption embed only on ' +
      'a rare save failure — cosmetic), R30 (width-loop early-break — verified ' +
      'safe; monotonicity holds). All 34 findings now resolved. +1 pytest (586 total).',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'Phase 3 batch: settle-window only for bot-opens, no off-hours discovery, CC-expiry cycle count',
    details:
      'Money-loss review Phase 3 (R22/R23/R25). R22: the 20-min settling window ' +
      '(which suppresses the spread loss-stop right after a fresh bot fill) was ' +
      'also applied to ADOPTED/hand-opened spreads — silencing their loss-stop ' +
      'for 20 min after the bot merely discovered them. It now only applies to ' +
      'bot-opened spreads (those with an open_order_id). R23: run_wheel now ' +
      'checks market-open BEFORE auto-discovery, so it no longer makes position/' +
      'quote API calls or fires adoption embeds off-hours (the auto-open cold-' +
      'start path already required market-open). R25: a covered call expiring ' +
      'worthless now increments cycle_count + appends history like the other ' +
      'paths (it was the only one that skipped it, leaving cycle reporting off ' +
      'by one). +4 pytest (585 total).',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'Phase 3 batch: cap buy-to-close at tracked qty, re-baseline ladder size, don’t clobber a 2nd short',
    details:
      'Money-loss review Phase 3 (R19/R20/R21), all manual/live. R19: ' +
      'place_buy_to_close(qty=None) closed the FULL Alpaca position — so if the ' +
      'user hand-sold extra contracts on the same OCC the wheel manages, the ' +
      '50%-close collapsed the user\'s extras too. It now caps at the bot\'s ' +
      'tracked contract count (the bot-duplicate case that motivated full-close ' +
      'is now prevented at the source by R1\'s client_order_id). R20: when the ' +
      'managed free-share count grows (covered-call collateral released, or the ' +
      'user added shares), initial_qty re-baselines so ladder sizing scales to ' +
      'the real position instead of the stale starting count. R21: single-leg ' +
      'discovery no longer overwrites a still-held tracked contract when a user ' +
      'holds a SECOND short option on the same underlying (one-contract-per-' +
      'ticker) — it keeps the first and surfaces the untracked second. +5 pytest (582 total).',
  },
  {
    date: '2026-06-17',
    category: 'fix',
    title: 'Phase 3 batch: multi-contract price, Stage-2 assignment detection, cheap-option close concession',
    details:
      'Money-loss review Phase 3 (R17/R18/R34). R17: get_option_last_price\'s ' +
      'position fallback divided the COMBINED market_value by 100, returning an ' +
      'N×-too-high price on a multi-contract position (which kept the 50%-profit ' +
      'close from triggering) — now divides by 100 × qty. R18: the Stage-2 ' +
      '"called away" check used a < 100-share heuristic that misfired on an ' +
      'odd-lot adoption or a partial manual sell (declaring a phantom assignment ' +
      'and dropping the shares / nakeding the call); it now only declares ' +
      'assignment when shares are actually gone (qty ≤ 0) and alerts + holds on ' +
      'an ambiguous 1..covered-1 remainder. R34: the buy-to-close limit nudge is ' +
      'now a ~5% concession (floored at 1¢) instead of a flat $0.05, which on a ' +
      '$0.05 option had DOUBLED the buy-back cost. +6 pytest (577 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Earnings guard now blocks same-day prints (completes Phase 2b)',
    details:
      'Money-loss review finding R16 (Phase 2b). yfinance often dates an ' +
      'earnings entry at midnight UTC; the old filter kept only timestamps ' +
      '>= now, so by the afternoon a same-day print was dropped as "past" and ' +
      'the SM opener could sell a spread straight into that evening\'s earnings. ' +
      '_next_earnings_dt now filters future earnings on the DATE, and ' +
      'next_earnings_within compares whole days (same-day = blocked, through the ' +
      'window). Deferred (reliability, not money-loss): a persistent earnings ' +
      'cache to survive yfinance rate-limits (needs a committed cache file + ' +
      'workflow step) and adding an earnings gate to the cons/agg CSP path ' +
      '(behavior change — needs sign-off). Completes Phase 2b (R12-R16). ' +
      '+4 pytest (571 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Auto-open: accept a $0-bid long hedge leg (don’t skip valid cheap spreads)',
    details:
      'Money-loss review finding R15 (Phase 2b). get_option_quote rejected any ' +
      'leg with a $0 bid OR $0 ask — correct for a SHORT leg we must be able to ' +
      'sell, but a far-OTM long hedge legitimately shows bid $0.00 / ask $0.05, ' +
      'and we BUY the long (only the ask matters). Skipping those made sm500 ' +
      'cheap-underlying spreads find no eligible width. get_option_quote gained ' +
      'a require_bid flag (default True keeps every caller strict); the auto-open ' +
      'long-leg fetch passes require_bid=False. SM accounts. +2 pytest (567 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Multi-open cycle: decrement buying power after each spread (no over-leverage)',
    details:
      'Money-loss review finding R14 (Phase 2b). When a cycle opens more than ' +
      'one spread (max_opens_per_cycle > 1), the buying-power check reused the ' +
      'start-of-cycle options_bp for every open — so the first open\'s collateral ' +
      'wasn\'t reflected and a second open could pass a BP gate it shouldn\'t ' +
      '(Alpaca would then 403 it). The local BP estimate is now decremented by ' +
      'the spread\'s collateral (width × 100) after each open. SM accounts (manual ' +
      'too if auto-open is re-enabled — it runs max_opens_per_cycle=2). +1 pytest (565 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Auto-opened spread: resolve a pending open by client_order_id if the numeric id is lost',
    details:
      'Money-loss review finding R13 (Phase 2b). If Alpaca ever returned an ' +
      'auto-opened spread order with a missing/null numeric id, ' +
      '_resolve_pending_spread misread the still-working open as "gone" — ' +
      'prematurely deleting state and firing a misleading "did not fill" embed ' +
      '(duplicate orders were already blocked by _working_spread_order_exists). ' +
      'The open now also captures the client_order_id that R1 stamps on every ' +
      'order (Alpaca echoes it), and resolves the pending order by it when the ' +
      'numeric id is missing. SM accounts. +4 pytest (564 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'SM auto-open: don’t trust the wheelability gate on a tiny candidate pool',
    details:
      'Money-loss review finding R12 (Phase 2b). normalize_scores percentile-' +
      'ranks the cycle’s candidates, but it always hands the single BEST one a ' +
      '100 — so the wheelability floor never actually blocks the #1 pick (the ' +
      'one that opens) regardless of pool size. On a degenerate 1-2 name pool ' +
      'that means a mediocre name gets rubber-stamped. New wheelability_min_pool ' +
      '(5 on the SM + manual auto-open blocks) holds single-stock opens when the ' +
      'eligible pool is too small to rank; the absolute credit/width + trend + ' +
      'risk gates still protect, and the curated bypass ETFs are unaffected. ' +
      'SM accounts (manual too if auto-open is ever re-enabled). +3 pytest (560 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Spread state hardening: net_credit guard + adopted-spread sanity clamp',
    details:
      'Money-loss review findings R10/R11 (Phase 2, completes it). R10: a ' +
      'corrupted spread state with net_credit/max_loss = None would crash ' +
      'handle_spread on the float() conversion and leave the spread unmanaged; ' +
      'it now skips the cycle with a warning. R11: when adopting a spread, ' +
      'net_credit is derived from Alpaca per-leg avg_entry_price, which can ' +
      'mis-split an mleg fill (most of the credit on one leg, ~0 on the other) ' +
      'and corrupt all P&L from the start; _detect_spread_pairs now validates ' +
      '0 < net_credit < width and clamps an out-of-band value into the valid ' +
      'range with a warning. Phase 2 done (R5-R11, 7 fixes). +4 pytest (557 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Tripwire-pending window no longer blocks a profit close; DTE-floor price guarded',
    details:
      'Money-loss review findings R8/R9 (Phase 2). R8: while a spread\'s ' +
      'underlying tripwire was pending its 60-min confirmation, handle_spread ' +
      'returned early and blocked EVERY other trigger — including the 50%-profit ' +
      'close. So a spread at 48% profit that briefly wicked the short strike was ' +
      'frozen for up to an hour and could reverse into a loss. Now the profit ' +
      'trigger runs during pending; only the noise-prone loss-stop (and the ' +
      'DTE-floor, which at ≤2 DTE is the same signal the confirmation window is ' +
      'meant to ride out — the MU case) stay deferred. R9: the DTE-floor price ' +
      'fetch is now wrapped in try/except like the tripwire, so a network blip ' +
      'near expiry skips the cycle instead of crashing the symbol and missing ' +
      'the close. Manual + SM. +4 pytest (553 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Spread closes now fill at a sane price (marketable limit, not market/mid)',
    details:
      'Money-loss review findings R5/R6/R7 (Phase 2). Three fixes to the spread ' +
      'CLOSE path (manual adopted spreads + SM): (R5) the multi-leg close was a ' +
      'MARKET order, which on an illiquid chain fills at the full bid/ask width ' +
      'crossed with no ceiling — undoing the careful near-mid OPEN discipline; ' +
      'it now rests a marketable LIMIT bounded at short_ask − long_bid. (R6) the ' +
      'leg-by-leg fallback priced at the MID, which sat below the ask and never ' +
      'filled (leaving the short open or a naked survivor); it now prices ' +
      'marketable (pay the ask to buy back the short, hit the bid to sell the ' +
      'long). (R7) a 200 "accepted" response with a terminal rejected/canceled ' +
      'status is no longer treated as a successful close (which would delete ' +
      'state on a still-open spread). +4 pytest (549 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Wheel 50%-close: decide on the quote mid, buy-to-close marketable (actually fills)',
    details:
      'Money-loss review finding R4. The wheel\'s 50%-profit close priced both ' +
      'the trigger decision AND the buy-to-close limit off the last TRADE. On ' +
      'an illiquid contract that\'s stale, so a BTC limit at stale-last+$0.05 ' +
      'could sit below the ask and never fill — yet state was cleared to ' +
      '"closed" and (on cons/agg) a new put was sold against the still-open ' +
      'short → false state / double short. _close_mark_and_limit now decides on ' +
      'the live quote MID and prices the buy-to-close MARKETABLE (the ask) so it ' +
      'fills, in both Stage 1 (puts) and Stage 2 (covered calls). Falls back to ' +
      'last trade only when no quote exists. Completes Phase 1 of the money-loss ' +
      'remediation (R1-R4, R31-R33: 7 fixes). +5 pytest (547 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Long-option exits now decide on the live quote, not a stale last trade',
    details:
      'Money-loss review finding R3. long_options_strategy decided take-profit ' +
      'and stop-loss off get_option_last_price (the last TRADE). On an illiquid ' +
      'contract that price can be hours/days stale — so a long that had actually ' +
      'collapsed showed only a small loss (stop never fired, rode to zero) and a ' +
      'long that had run showed a phantom +100% (premature take-profit on a ' +
      'still-winning position). evaluate_position now prefers the live two-sided ' +
      'quote MID, falling back to last trade only when no quote exists. Affects ' +
      'cons/agg + manual + live. +5 pytest (542 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Averaging down no longer triggers a spurious trailing-stop liquidation',
    details:
      'Money-loss review finding R2. When you manually added shares at a lower ' +
      'price (averaged down), the drift reconciliation reset qty/avg/stop but ' +
      'left a stale high-water mark + active trail. Because the trailing block ' +
      'only ever RAISES the stop, it snapped the stop back above your new cost ' +
      'basis and stopped you out of the shares you just bought on the dip. Now ' +
      'an average-down re-baselines the trail (high-water mark + entry → new ' +
      'avg cost, trailing reset) so the stop sits at new_avg × 0.90; an ' +
      'average-up keeps its ratcheted trail. Affects manual + live + SM. ' +
      '+3 pytest (537 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Live mode now refuses to run against the paper endpoint (fail loud, not silent)',
    details:
      'Money-loss review finding R33. If ALPACA_LIVE_BASE_URL were ever ' +
      'missing, malformed, or a placeholder, apply_mode silently fell back to ' +
      'the paper endpoint — so the live script would happily "trade" the paper ' +
      'account while the real-money account sat completely unmanaged (missed ' +
      'stops, unmanaged spreads, uncollected premium). Now apply_mode hard-' +
      'fails with a RuntimeError when live resolves to a paper URL, in both ' +
      'wheel_strategy and strategy (long_options inherits it). A pre-live-' +
      'cutover safety landmine, defused. +10 pytest (534 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Conservative/aggressive stop no longer liquidates covered-call collateral',
    details:
      'Money-loss review finding R31. The TSLA stop in run_one_cycle used ' +
      'close_all (DELETE /positions/{sym}), which liquidates EVERY share — ' +
      'including shares locked as covered-call collateral after a wheel ' +
      'assignment (stage 2). That would leave a naked short call (unlimited ' +
      'upside risk) and also dump the wheel\'s assigned shares. The stop now ' +
      'sells only the freely-available shares (qty_available) via a bounded ' +
      'sell order, and holds + alerts when every share is CC collateral — ' +
      'mirroring the manual path. cons/agg only (live already used the safe ' +
      'manual path). +3 pytest (524 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Hedge guard now protects call credit spreads too (no more accidental naked short calls)',
    details:
      'Money-loss review finding R32. long_options_strategy\'s hedge guard ' +
      '(which stops it from selling a spread\'s long leg and leaving the short ' +
      'naked) only recognized PUT credit spreads. A user-opened CALL credit ' +
      'spread\'s long call was unprotected — if it lost >50%, the bot could ' +
      'stop-loss it and leave a naked short call (unlimited upside risk), the ' +
      'most dangerous position the bot can create. _unpaired_hedge_long_occs ' +
      'now also protects a long call paired with a short call at a LOWER strike ' +
      '+ same expiration, type-matched so puts and calls never cross. Affects ' +
      'manual + live. +3 pytest (521 total).',
  },
  {
    date: '2026-06-16',
    category: 'fix',
    title: 'Bot orders are now idempotent (client_order_id) — no more double-placing on retry',
    details:
      'Critical fix found by a dual-model adversarial code review (R1). Every ' +
      'order the bot places funneled through an HTTP layer that retries POSTs ' +
      'on 5xx/timeout, with NO client_order_id anywhere — so if Alpaca created ' +
      'the order but the response was lost (gateway 502/504 or a dropped ' +
      'connection), the bot re-sent the identical order and got TWO. Almost ' +
      'certainly the root of the historical "MARA went to qty=-4" incident, and ' +
      'a real-money hazard because it lives in the shared layer every order ' +
      'uses (including the live account\'s manage-only closes).\n\n' +
      'Now every POST /orders carries a deterministic client_order_id ' +
      '(wheel_strategy.api_post + strategy.place_order; long_options inherits ' +
      'via import). A retry re-sends the same id; Alpaca rejects the duplicate ' +
      '(422) and we resolve to the already-created order instead of failing. ' +
      'Applies to all seven modes. First fix from the 2026-06-16 money-loss ' +
      'remediation plan (34 findings). +6 pytest (518 total).',
  },
  {
    date: '2026-06-16',
    category: 'engine',
    title: 'Spread tripwire: tolerate intraday noise (DTE gate + 60-min confirmation) on manual',
    details:
      'Two manual put credit spreads (MU, QQQ) closed for a few-hundred-dollar ' +
      'loss each the instant the stock touched the short strike — then both ' +
      'recovered above the strike within 1–2 hours. The original underlying ' +
      'tripwire closed on the FIRST touch at ANY DTE, which is the wrong reflex ' +
      'for a defined-risk spread: the loss is already capped at the width, so ' +
      'closing on an intraday wick just realizes a near-max loss and forfeits the ' +
      'recovery.\n\n' +
      'Manual now narrows the tripwire to where an ITM short leg actually means ' +
      'something:\n' +
      '• DTE gate — only arm in the final 2 days (spread_tripwire_dte: 2), where ' +
      'pin/assignment risk is real. QQQ (9 DTE) would no longer arm at all.\n' +
      '• Confirmation window — even when armed, require the stock to stay through ' +
      'the short strike for 60 continuous minutes before closing ' +
      '(spread_tripwire_confirm_minutes: 60). A recovery above the strike resets ' +
      'the clock. MU (back above within the hour) would ride through.\n\n' +
      'Waiting costs nothing structurally — defined risk caps the loss at the ' +
      'width while we wait. SM/cons/agg/live are byte-unaffected (gates default ' +
      'to None/0 = close on first touch at all DTEs, the original behavior).',
  },
  {
    date: '2026-06-03',
    category: 'fix',
    title: 'Proactive sweep: PDT-quiet every close boundary (wheel stages, orphans, long options)',
    details:
      'Rather than keep reacting to each new PDT #errors ping, audited every ' +
      'order-placing / position-closing path across the bots and quieted the ' +
      'whole class at its error boundaries — these protect the LIVE real-money ' +
      'account too (same scripts; live can itself be sub-$25k).\n\n' +
      '• wheel_strategy.report_pdt_quietly() centralizes the policy. Applied at: ' +
      'the per-symbol wheel handler (covers handle_stage1/stage2 put & covered-' +
      'call 50% closes), both _handle_orphan_leg paths, and the spread-STC ' +
      'orphan branch.\n' +
      '• Fixed a real latent bug found in the audit: the wheel\'s per-symbol ' +
      'handler treated EVERY 403 as "BP exhausted" and break-ed the whole ' +
      'symbol loop — so a single PDT denial silently halted management of all ' +
      'remaining symbols each cycle. PDT is now detected first and continues.\n' +
      '• long_options_strategy gets a matching _report_pdt_quietly at its ' +
      'sell-to-close + per-position boundaries (the AAL-churn exit path).\n\n' +
      'All routes now: PDT (40310100) → quiet #actions notice + pdt_blocked ' +
      '(skipped); genuine errors still hit #errors with the full Alpaca body. ' +
      '+8 tests (508 total).',
  },
  {
    date: '2026-06-03',
    category: 'fix',
    title: 'strategy.py manages only freely-sellable shares (covered-call collateral fix)',
    details:
      'A third distinct #manual-errors source (after the PDT fixes): SNAP held ' +
      '110 shares with 100 locked as covered-call collateral (wheel stage 2). ' +
      'strategy.py adopted the full 110 via position-drift reconciliation, its ' +
      'stop fired, and it tried to liquidate all 110 via DELETE /positions/SNAP ' +
      '— Alpaca rejected 40310000 "insufficient qty available (requested 110, ' +
      'available 10)", crashing the symbol cycle into #errors every tick. Not a ' +
      'PDT error, so the PDT guard correctly did not catch it.\n\n' +
      'Fix: new _available_qty() reads Alpaca qty_available (excludes shares ' +
      'held as options collateral / reserved by open orders). Manual seeding + ' +
      'reconciliation now track only the free shares — the locked portion ' +
      'belongs to wheel_strategy.py\'s covered call. The stop now sells exactly ' +
      'that managed quantity (place_order sell) instead of close_all\'s full ' +
      'liquidation, so it can never collide with CC collateral again. Once the ' +
      'account is PDT-restricted the bounded sell still gets denied — but now ' +
      'as a clean 40310100 the guard routes quietly to #actions, not #errors.',
  },
  {
    date: '2026-06-03',
    category: 'fix',
    title: 'Quiet PDT-blocked stock exits in strategy.py too (not just wheel spreads)',
    details:
      'After quieting PDT-blocked spread closes in wheel_strategy.py, ' +
      '#manual-errors kept pinging — a second path was uncovered. strategy.py ' +
      '(the stock trail/ladder/stop manager) was trying to liquidate the SNAP ' +
      'position via DELETE /v2/positions/SNAP, hitting the same PDT denial ' +
      '(40310100), and crashing the symbol cycle as an unhandled "cycle ' +
      'exception" → #errors.\n\n' +
      'Mirrored the two helpers into strategy.py (alpaca_err_detail, ' +
      'is_pdt_denied — these scripts intentionally duplicate their Alpaca ' +
      'request layer) and branched the per-symbol cycle-exception handler: a ' +
      'PDT-denied exit now posts a quiet "⏸️ exit blocked by PDT" notice to ' +
      '#*-actions and logs exit_pdt_blocked (skipped) instead of a red #errors ' +
      'ping. Covers manual AND the three SM accounts (all sub-$25k, all use the ' +
      'same auto-discover loop). Conservative/aggressive/live are unaffected.',
  },
  {
    date: '2026-06-03',
    category: 'config',
    title: 'Manual: disable auto-open spreads (PDT) + route PDT-blocked closes to #actions',
    details:
      'The "403 Forbidden" spread-close loop turned out to be Alpaca Pattern ' +
      'Day Trading protection (code 40310100), not buying power. The manual ' +
      'account is a margin account under $25k, and the auto_open_spreads ' +
      'engine churned same-day round trips — once past 3 day trades in 5 days, ' +
      'Alpaca denied EVERY further order, including the closes the manager ' +
      'needed, so a stuck NVDA spread retry-looped #manual-errors every cycle.\n\n' +
      'Two changes: (1) auto_open_spreads disabled on manual — autonomous ' +
      'same-day spread churn is structurally incompatible with a sub-$25k ' +
      'margin account (the opener-side config keys stay inert, so re-enabling ' +
      'is a one-line flip). Hand-opened/adopted spreads are still managed ' +
      'normally. (2) PDT-denied closes (is_pdt_denied) now post a quiet ' +
      '"⏸️ close blocked by PDT" notice to #*-actions instead of pinging ' +
      '#*-errors every 10 min — a PDT block is not a fixable per-cycle error.\n\n' +
      'The stuck position itself can only clear once the PDT restriction lifts ' +
      '(equity ≥ $25k or account reset on Alpaca).',
  },
  {
    date: '2026-06-02',
    category: 'fix',
    title: 'Spread close errors now surface the actual Alpaca reason (not just "403 Forbidden")',
    details:
      'A bot-opened NVDA put credit spread on the manual account hit a 403 on ' +
      'every buy-to-close attempt and retry-looped each cycle, but #manual-errors ' +
      'only showed "403 Client Error: Forbidden for url: …" — the real reason ' +
      '(Alpaca returns it in the HTTP response BODY, e.g. {"code":40310000,' +
      '"message":"insufficient buying power"}) was being discarded by ' +
      "requests' raise_for_status().\n\n" +
      'Added alpaca_err_detail() in wheel_strategy.py: it appends the response ' +
      'body to the exception string. Wired into the multi-leg close log and both ' +
      'single-leg fallback embeds (BTC short, STC long). Spread-close failures ' +
      'now also emit a structured spread_close_failed JSONL event (previously ' +
      'invisible in logs — only the Discord embed fired, so the structured log ' +
      'showed a clean cycle_complete while the close silently failed).\n\n' +
      'Purely additive — no change to trading behavior. The next 403 will state ' +
      'exactly why it was rejected.',
  },
  {
    date: '2026-05-30',
    category: 'engine',
    title: 'Spread engine: stop the per-trade bleed (open near mid, mid-based stop, hedge guards)',
    details:
      'Bot-opened put credit spreads were losing on nearly every trade. Root ' +
      'cause: the engine decided on MID prices but executed and stopped on the ' +
      'worst-case bid/ask cross, so on wide chains it opened cheap, stopped out ' +
      'on the spread itself, and orphaned hedge legs that then rotted.\n\n' +
      'Five coordinated fixes (manual + SM modes; conservative/aggressive/live ' +
      'byte-unaffected):\n' +
      '1. Open near the mid. The opener used to cross the full bid/ask ' +
      '(short_bid - long_ask), giving away the whole spread on entry — MU ' +
      'opened at $1.50 against a $3.65 mid. Now rests between mid and ' +
      'marketable (40% concession, never below 60% of mid).\n' +
      '2. Liquidity gate. Reject opens whose executable credit is below 60% of ' +
      'the mid — the chain is too wide to transact reliably. Would have blocked ' +
      'the MU trade outright.\n' +
      '3. Mid-based stop. The stop is judged on the mid, not the worst-case ' +
      'executable cost, so the bid/ask width alone can no longer fake a 50%/75% ' +
      'loss minutes after a fill (MU stopped out -$175 in 20 min).\n' +
      '4. Manual underlying tripwire + 20-min settling window. Manual now closes ' +
      'when the stock trades through the short strike (pure risk protection), and ' +
      'suppresses the loss-stop for 20 min post-open so a fresh spread cannot ' +
      'insta-stop on quote noise.\n' +
      '5. Hedge guards + marketable closes. A short put with an un-paired long ' +
      'hedge is held, not 50%-closed naked (the AAL bleed); the long hedge is ' +
      'protected from long_options; and orphan / urgent closes now price ' +
      'marketable so they actually fill instead of resting at the mid and ' +
      'churning a stuck stop-loss for days (AAL 06/12 $12.50 put).\n\n' +
      '+25 pytest (now 496).',
  },
  {
    date: '2026-05-27',
    category: 'ui',
    title: 'Watchlist scrolling ticker under the tmux bar',
    details:
      'New WatchlistTicker component sits inside the main column, flush ' +
      'against the tmux bar. Renders each watchlist symbol as a chip ' +
      '(symbol · price · day% with arrow · 30d sparkline) inside a CSS ' +
      'marquee. Content rendered 2x so translateX(-50%) gives a seamless ' +
      'loop. Animation duration scales with symbol count, pauses on hover, ' +
      'honors prefers-reduced-motion. Bar hides itself when the watchlist ' +
      'is empty. Reuses the existing [\'watchlist\'], [\'quote\', symbol], ' +
      'and [\'bars\', symbol, \'30d-1Day\'] query keys so visiting one ' +
      'route warms the other.',
  },
  {
    date: '2026-05-24',
    category: 'ui',
    title: 'Spread form gets TIF chip + calendar cards get a real payoff preview',
    details:
      'Two small fixes:\n\n' +
      '1. SpreadOrderForm now has a TIF (day / gtc) chip row matching the ' +
      'stock and option forms. Defaults to day. Plumbed through ' +
      '/api/trades/preview + submit (added optional tif to SpreadPayload) ' +
      'and used for both the Alpaca mleg order\'s time_in_force AND the ' +
      'stored trade record. Existing callers that omit tif still default ' +
      'to day so nothing breaks.\n\n' +
      '2. The 3 calendar-spread cards on /strategy/:symbol previously ' +
      'rendered as solid color blocks because their expiry-only payoff is ' +
      'a flat line (the real P&L depends on front/back IV decay). Added ' +
      'an optional previewPoints override to StrategyDef + a calendarTent ' +
      'helper that produces a hand-tuned bell (tent for long calendars, ' +
      'well for short calendars). Honest about what calendars actually do ' +
      'without lying about the math. The cards stay coming-soon — only the ' +
      'preview shape changed.',
  },
  {
    date: '2026-05-23',
    category: 'ui',
    title: '/trades: per-page chip + page counter on prev/next',
    details:
      'Pagination footer rebuilt:\n' +
      '  • SHOW chips: [25] [50] [100] [all] on the left. "all" sends 9999 ' +
      'to the API (capped server-side at 10k).\n' +
      '  • PAGE x / y indicator between the show chips and the nav buttons.\n' +
      '  • prev(N) and next(N) show the destination page number — e.g. on ' +
      'page 1 of 5 you see [< prev] (disabled) and [next(2) >]. On the ' +
      'last page next is disabled with a "no more pages" tooltip.\n\n' +
      'Backend cap raised 200 → 10,000 so "all" actually means all (KV ' +
      'reads are sequential but the explicit user choice is fine).',
  },
  {
    date: '2026-05-23',
    category: 'feature',
    title: '/trades: tag filter chips + auto-import bot trades every cron tick',
    details:
      'Two changes to make /trades the single source of truth across all 7 ' +
      'accounts:\n\n' +
      '1. Tag filter row added under the existing filter chips. Click any ' +
      'tag chip to filter the table to just trades carrying that tag (e.g. ' +
      '"bot_opened", "assigned", "wheel_50pct"). Backend already supported ' +
      'the tag param — this just wires the UI.\n\n' +
      '2. The grade-open-trades cron now auto-imports bot-opened trades ' +
      'from every bot-touched account each tick (every 5 min during market ' +
      'hours). Per-account cursor stored at import:cursor:<account>; first ' +
      'run looks back 7 days. Cursor only advances on success so a failed ' +
      'tick retries the same window next time. Tag policy:\n' +
      '  • cons/agg/sm500/1000/2000 → \'imported\' + \'bot_opened\' (100% bot)\n' +
      '  • manual/live              → \'imported\' (mixed; user attributes)\n\n' +
      'Refactor: the body of /api/trades/import was extracted to a pure ' +
      'runImport({ account, since, extraTags }) function so both the HTTP ' +
      'endpoint and the cron call it. Dynamic import in the cron breaks the ' +
      'module-init cycle with trades/[action].ts (which already imports ' +
      'runGradeOpenTrades from cron/[job].ts). No new Vercel functions ' +
      '(still 10/12).',
  },
  {
    date: '2026-05-23',
    category: 'feature',
    title: 'Tag library expanded + outcome tags auto-applied at close',
    details:
      'Seeded the tag picker with 16 new tags: the missing spread types ' +
      '(put_debit, call_credit, call_debit), outcome tags (assigned, ' +
      'called_away, rolled, expired_worthless), source tags (bot_opened, ' +
      'adopted, congress_copy, imported), behavior diagnostics ' +
      '(revenge_trade, fomo, gut_feel), and IV context (high_iv, low_iv). ' +
      'Seed list auto-merges into the live KV list on next /settings/tags ' +
      'GET — no migration needed.\n\n' +
      'Three of the outcome tags are now applied automatically by the ' +
      'grade-open-trades cron when it detects the close type:\n' +
      '  • STO put + assigned       → assigned\n' +
      '  • STO call + assigned      → called_away\n' +
      '  • STO + expired + pnl > 0  → expired_worthless\n\n' +
      'The "assigned" tag also inherits to the spawned stock trade via the ' +
      'existing tag-inheritance path. Behavior, IV, and source tags stay ' +
      'manual for now — they\'re judgment calls or bot-side state the ' +
      'dashboard cron can\'t observe directly. "rolled" detection (close + ' +
      're-open on the same underlying within minutes) is a future ask.',
  },
  {
    date: '2026-05-23',
    category: 'ui',
    title: 'Order forms: live "Total Cost / Credit" + "Collateral Held" panel',
    details:
      'Every order form (stock, single option, spread) now shows a small ' +
      'panel above the Review button with two lines: "Total Cost" (red) ' +
      'when cash leaves your account, or "Total Credit" (cyan) when cash ' +
      'comes in — plus "Collateral Held," the buying power locked while ' +
      'the position is open. Updates live as you change strikes, qty, or ' +
      'limit price. Stock buy → cost = qty × price, collateral = same. ' +
      'STO option → credit = premium, collateral = strike × 100 × qty. ' +
      'Credit spread → credit = net × 100 × qty, collateral = max loss. ' +
      'Debit spread → debit = net × 100 × qty, no extra collateral.',
  },
  {
    date: '2026-05-23',
    category: 'ui',
    title: 'Spread builder: selected legs highlighted in the chain',
    details:
      'When you click a bid or ask on the spread order form, the chosen cell ' +
      'now gets a colored box (red ring on the short bid, cyan ring on the ' +
      'long ask) and the matching row gets a subtle tint. Makes it obvious ' +
      'which strikes you\'ve picked without scrolling back up to the dropdowns.',
  },
  {
    date: '2026-05-23',
    category: 'feature',
    title: 'Options Strategy Builder page + 4 vertical spread types',
    details:
      'New /strategy/:symbol page (Robinhood-style picker) replaces the single ' +
      '"Build Put Credit Spread" link on /lookup. Renders a grid of 13 strategy ' +
      'cards across 4 sections (Single Leg, Vertical Spreads, Straddles and ' +
      'Strangles, Calendar Spreads) — each card shows a mini SVG payoff curve ' +
      'derived from the same payoff engine the full PayoffChart uses, so each ' +
      'card scales naturally to whatever symbol you\'re on (sample strikes are ' +
      'relative to spot, not hardcoded).\n\n' +
      'Wired cards (8 total): Long Call, Long Put, Covered Call, Cash-Secured ' +
      'Put (single-leg flow → /strategy/:symbol/pick → chain locked to the ' +
      'right leg type → click any strike to land in the existing OptionOrderForm ' +
      'pre-filled with the forced BTO/STO from the strategy intent); plus all 4 ' +
      'vertical spreads (Call Debit / Call Credit / Put Debit / Put Credit) → ' +
      'the existing SpreadOrderForm, now generalized to all 4 types.\n\n' +
      'Coming-soon cards (5 total): Long Straddle, Long Strangle, Long Call ' +
      'Calendar, Long Put Calendar, Short Put Calendar — render visibly but ' +
      'are disabled. Adding these later means wiring 3-leg / multi-expiration ' +
      'shapes in SpreadDetails + the order form.\n\n' +
      'Schema change: SpreadDetails.spread_type widened from \'put_credit\' to ' +
      'the SpreadType union (put_credit | put_debit | call_credit | call_debit). ' +
      'Added optional net_debit + max_profit fields so debit-spread P&L is ' +
      'recorded correctly without overloading net_credit. Existing put_credit ' +
      'records are byte-unaffected (net_debit is undefined, max_profit equals ' +
      'net_credit). limit_price sign convention stays the same: negative for ' +
      'credit (you receive), positive for debit (you pay).\n\n' +
      'Bot-management posture: only put_credit on manual_paper is bot-managed ' +
      '(handle_spread runs the 75%/2× stop / 50% profit / DTE-≤2 close logic). ' +
      'Every other spread type renders an amber banner in the form: "Bot will ' +
      'track this <type> but won\'t auto-close. Manage it manually." This ' +
      'matches today\'s posture where cons/agg spreads (even put_credit) are ' +
      'already hand-managed. Live stays disabled across all spread types.\n\n' +
      'Tests: +15 strategy-catalog (intent routing, payoff shapes), +7 ' +
      'StrategyBuilder (cards render, disabled coming-soon, click routing), ' +
      '+6 StrategyPickContract (intent forcing, chain side lock), +5 ' +
      'SpreadOrderForm (all 4 vertical types, banner visibility), +4 OrderNew ' +
      '(new spread params recognized + invalid rejected), +1 ConfirmModal ' +
      '(debit-spread summary), +2 API trades-preview (put_debit + invalid ' +
      'spread_type rejection), +1 Lookup (new button href). Total: 607 vitest / ' +
      '90 files (was 492 / 80). Bot pytest count unchanged.',
  },
  {
    date: '2026-05-22',
    category: 'config',
    title: 'Manual spread stop-loss loosened 50% → 75% of max loss',
    details:
      "Shipped same evening as the MU stop-out. MU auto-opened at 13:02 (short \\$755, " +
      "$4.99 mid credit, $501 max loss) and stopped out 19 minutes later at 13:21 on " +
      "a routine ~1% intraday move on the underlying. At Δ −0.40 short delta the " +
      "spread lives close enough to ATM that a 50%-of-max-loss trigger fires on " +
      "transient noise that would have reverted later that day. Loosening to 75% " +
      "gives theta more room to work and reduces whipsaw stop frequency.\n\n" +
      "Tradeoff: bigger realized loss per stop (~\\$375 vs \\$250 on a $500 max-loss " +
      "spread) when the move IS real. The bet is that fewer-but-larger losses + more " +
      "wins surviving to 50% profit beats more-but-smaller losses + winners stopped " +
      "out early.\n\n" +
      "Manual-only. SM modes (sm500/sm1000/sm2000) keep their tighter 0.50 + 2× credit " +
      "stop (the hardened-engine guardrails added 2026-05-19 after the SM bleed). " +
      "cons/agg/live keep 0.50 too — though spread_management is False on those so " +
      "it's moot in practice.",
  },
  {
    date: '2026-05-22',
    category: 'engine',
    title: 'Manual auto-opener: bypass priority + inline concurrency cap',
    details:
      'Two follow-ups to the same-day auto-opener changes. After shipping ' +
      'max_opens_per_cycle=2 + wheelability bypass, observed two real bugs:\n\n' +
      '1) Bypass symbols (QQQ/SPY/IWM) STILL never got attempted. Original bypass ' +
      'design let them through the percentile floor but kept them at the BOTTOM of ' +
      "the score-sorted iteration. With 49 single stocks ahead of them and only 2 " +
      'slots per cycle, the single stocks always ate both slots before the loop ' +
      'reached the bypass tail. Fix: bypass symbols are now iterated FIRST every ' +
      "cycle, then score-sorted single stocks fill the remaining slots. Every cycle " +
      'QQQ/SPY/IWM get at least one attempt at the gauntlet (c/w 33%, risk cap, ' +
      "trend, BP, earnings) — they still need to clear those, but they're no longer " +
      'starved by single-stock score dominance.\n\n' +
      '2) Concurrency cap was checked only at the TOP of the cycle. With ' +
      'max_opens_per_cycle=2 just shipped, observed 3 existing + 2 new = 5 spreads ' +
      'against a cap of 4 (one cycle of overshoot). Fix: inline check after each ' +
      'open — break out of the loop when open_spreads + opens_this_cycle reaches ' +
      'cap, never exceed it again.\n\n' +
      '+2 pytest tests (bypass-tried-first, inline-cap-stops-mid-cycle). ' +
      'Bot total: 471 pytest. Picks up on next cron tick.',
  },
  {
    date: '2026-05-22',
    category: 'engine',
    title: 'Manual auto-opener: 2 opens/cycle + retry-on-failure (lets ETF + single-stock both fill)',
    details:
      'Two follow-up changes after the first day of real auto-opens on manual revealed two ' +
      'related problems:\n\n' +
      '1) max_opens_per_cycle bumped 1 → 2 on manual. With max=1, every cycle the score-race ' +
      'winner (always a single stock — premium_yield = bid/strike inherently favors cheap names) ' +
      'grabs the only slot and the loop returns. ETFs in wheelability_bypass_symbols sit at the ' +
      'bottom of the iteration with low raw scores and never get reached. Bumping to 2 lets the ' +
      'single-stock winner AND a bypass ETF both fill on the same cycle. Risk cap (10% per spread), ' +
      'concurrency cap (4 max), and credit-to-width gate (33%) still bound total exposure — ' +
      'manual at $10k can safely hold 4 spreads of up to $1000 max loss each.\n\n' +
      '2) Open-failure path switched from `return` to `continue`. When _open_spread_mleg raises ' +
      '(observed today: Alpaca returned HTTP 403 Forbidden on NVDA and MU spread attempts), the ' +
      'opener now logs the failure and falls through to the next eligible symbol. Previously the ' +
      "single attempt burned the whole cycle's slot. NVDA 403 then MU 403 then nothing — three " +
      'wasted cycles in a row.\n\n' +
      'SM modes (sm500/sm1000/sm2000) left at max_opens_per_cycle=1 — the SM Balanced posture is ' +
      'deliberately one-shot per cycle. Only manual was bumped.\n\n' +
      '+3 pytest tests (failure-fall-through, manual-opens-two-per-cycle, SM-modes-still-cap-at-1). ' +
      'Bot total: 469 pytest. Picked up on the next cron tick.',
  },
  {
    date: '2026-05-22',
    category: 'fix',
    title: 'Auto-spread opener: long-leg pinned to short-leg expiration (no more diagonals)',
    details:
      "First real auto-open on manual (AAL 06/18 \\$13.50 short + 06/12 \\$12.50 long) " +
      'came out as a diagonal, not a vertical. Root cause: find_best_contract scored ' +
      'candidates by strike-distance × expiration-distance with target_exp = today + 21d, ' +
      "so when looking for the long it preferred 06/12 (exp_diff 0) over 06/18 (exp_diff 6). " +
      "The downstream pairing code in _detect_spread_pairs correctly requires matching " +
      'expirations, so the next cycle couldn\'t pair them and adopted the short as a bare ' +
      "Stage 1 CSP — leaving the user with a diagonal Alpaca position that the bot didn't " +
      'recognize as a spread.\n\n' +
      'Two fixes shipped together:\n\n' +
      '1) find_best_contract gained an optional exp_date kwarg. When set, the API query ' +
      'is hard-locked to a single expiration. The auto-opener now passes the short s ' +
      'expiration to the long-leg picker, guaranteeing the same expiration for both legs.\n\n' +
      '2) _open_spread_mleg validates same-expiration up front and raises ValueError on ' +
      'mismatch — defense in depth so a future code path that forgets to pin can\'t place ' +
      'a diagonal.\n\n' +
      '+5 pytest tests (exp_date wiring, legacy regression, mleg mismatch rejection, mleg ' +
      'match acceptance, end-to-end auto-opener long-leg pinning). Bot total: 466 pytest.\n\n' +
      "Note: the AAL diagonal opened today is live on the manual paper account and won't " +
      'be retroactively repaired by this fix — the bot is now managing the short as a bare ' +
      'Stage 1 CSP and the long as an orphan long put (long_options_strategy.py). User needs ' +
      'to decide: close both legs manually, buy a matching 06/18 \\$12.50 long to convert to ' +
      "a real vertical, or let it ride (short is naked from 06/12 to 06/18 if AAL doesn't " +
      'breach \\$12.50 by 06/12).',
  },
  {
    date: '2026-05-22',
    category: 'engine',
    title: 'Manual auto-opener: delta-target short selection + ETF wheelability bypass',
    details:
      'Two structural changes so manual mode can auto-open spreads on broad-market ETFs ' +
      '(QQQ/SPY/IWM), not just high-IV cheap single stocks. Manual-only — cons/agg/live/SM all ' +
      'unchanged.\n\n' +
      '1) Short-leg selection switched from the 10%-OTM strike rule to a Δ −0.40 delta target. ' +
      'The 10%-OTM rule is calibrated for high-IV single stocks; on a low-IV ETF it lands at ' +
      'Δ ≈ −0.03 with negligible premium, so the credit-to-width gate (33%) never passes. ' +
      'Targeting Δ −0.40 self-calibrates across IV regimes — same anchor produces a 10%-OTM ' +
      'strike on a high-IV cheap stock and a near-ATM strike on a low-IV ETF, both with c/w ' +
      'comfortably above the floor. New helper find_contract_by_delta() uses the chain-snapshot ' +
      'endpoint (greeks in one shot).\n\n' +
      '2) Added wheelability_bypass_symbols = [QQQ, SPY, IWM]. The percentile-80 floor uses ' +
      'premium_yield = bid/strike, which always lands ETFs near the bottom (denominator is ' +
      'hundreds of dollars) regardless of strike target. Bypass skips the floor for these ' +
      'three symbols — every other gate still applies (credit/width, risk cap, trend filter, ' +
      'BP, earnings).\n\n' +
      'Also bumped manual\'s bp_switch_threshold 5000 → 50000. The 5000 value was inherited ' +
      'from sm1000\'s Balanced posture, where BP is always under $1k so the gate is moot; on a ' +
      '$10k manual account BP sits above 5000 most of the time, blocking every spread open. ' +
      'wheel_skip_new_puts is True on manual so a CSP would never be opened anyway — the BP ' +
      'switch is effectively disabled, and the spread path is always taken when ' +
      'auto_open_spreads is True.\n\n' +
      '+11 pytest tests (delta picker, OCC parsing, bypass gating, legacy-path regression). ' +
      'Bot total: 461 pytest. Picked up by the next cron tick.',
  },
  {
    date: '2026-05-22',
    category: 'ui',
    title: 'Dashboard UX batch: clickable bid/ask, embedded chain in spread form, display-name profile, DTE in expirations, navbar reorder',
    details:
      'Six related polish items shipped together:\n\n' +
      '1) Options-chain bid/ask cells are now real buttons. Click bid → /order/new opens with side=STO ' +
      'and the bid price prefilled as the limit (you sell at the bid). Click ask → side=BTO with the ask ' +
      'prefilled (you buy at the ask). Same brokerage-style behaviour as Alpaca/Robinhood/etc.\n\n' +
      '2) SpreadOrderForm now embeds the same OptionsChain right below its expiration dropdown — ' +
      "premiums are visible upfront for every strike, no more clicking through dropdowns blind. Click bid " +
      'on a strike → populates the SHORT leg. Click ask on a strike below the short → populates the LONG ' +
      'leg. (Clicking ask on a strike above current short auto-promotes it to short.) The chain is ' +
      'locked to puts + the selected expiration. Existing strike dropdowns kept as keyboard fallback.\n\n' +
      '3) Display name is now configurable in Settings → profile. Default "trader". Replaces the ' +
      'hardcoded "tim" in every terminal-prompt header (e.g. `pat@dash:~/portfolio$`) and the ' +
      '`TIM_DASH` sidebar logo (now `PAT_DASH` etc.). GET endpoint is public (login page can read it ' +
      'before auth); POST requires auth + a regex-validated name (1–24 chars, starts with a letter).\n\n' +
      "4) The AI coach's grading prompt now addresses the trader by their configured display name " +
      '(e.g. "You are an honest trading coach for a single trader (Pat)"). Falls back to "the trader" ' +
      'when no name is set.\n\n' +
      '5) Expiration dropdowns (OptionsChain on /lookup + SpreadOrderForm) now show "(N DTE)" next to ' +
      'each date — e.g. `06/19/2026 (28 DTE)`. Computed from today at render time, so always accurate. ' +
      '"(expired)" for past dates.\n\n' +
      '6) Sidebar reorder: settings moved to a bottom "ACCOUNT" cluster with changelog + sign-out, ' +
      'freeing top-nav real estate for the daily-trading + research pages in usage order: home, ' +
      'positions, orders, trades, lookup, watchlist, calendar, rules, performance. Top-bar tmux ' +
      'indicator now lists trades as window 4 (was lookup).\n\n' +
      'Tests: +21 vitest (clickable bid/ask × 4, embedded chain × 4, DTE × 2, display-name API × 8, ' +
      'grading-prompt name injection × 2, order prefill from URL × 2 — minus 1 existing test ' +
      'restructured). New totals: 526 vitest / 84 files (was 505/83). Bot pytest unaffected at 450.',
  },
  {
    date: '2026-05-22',
    category: 'config',
    title: 'SM universe: added broad-market ETFs SPY, QQQ, IWM (55 names total)',
    details:
      'Added the three big index ETFs to the curated universe. Reasoning: ETFs are immune to ' +
      'single-name earnings risk (no IV crush from a bad print), structurally "happy to own," and ' +
      'add some non-stock diversification to a list that was getting heavy on tech + financials.\n\n' +
      "Tradeoff: ETFs have lower IV than individual stocks, so premiums are thinner — the 33% " +
      'credit-to-width gate will let through fewer of these than meme-tier names like MU or PLTR. ' +
      "That's intentional; we want quality over volume.\n\n" +
      'Verified live chains before adding:\n' +
      '• SPY ($742.91) — deep liquidity, tight absolute spreads, clean OI\n' +
      '• QQQ ($714.97) — same\n' +
      '• IWM ($282.48) — same, with OI 272-1570 on near-the-money strikes\n\n' +
      'Considered + REJECTED: VOO ($682.89) showed zero bids at target deltas (no live takers ' +
      'near our strikes — would silently fail every cycle). VB ($286.38) had a 195% bid/ask ' +
      'spread on the top candidate with OI 13 — too thin for the wheel.\n\n' +
      'All three are $5-strike at these prices → $500 raw width on a min-width spread. Fits ' +
      'manual ($1k risk cap) cleanly; SM accounts will gate them out on the budget check ($100-200 ' +
      "cap can't accommodate $500 max loss). That's fine — same graceful fallback as MU/NVDA.",
  },
  {
    date: '2026-05-22',
    category: 'feature',
    title: 'Manual refresh button on /trades — force sync against Alpaca without waiting for cron',
    details:
      'New [↻ refresh] button top-right of /trades. Runs the same logic as the 5-min grade-open-trades ' +
      'cron on-demand: walks every open trade, syncs delayed fills, detects external closes (via Path ' +
      "3 added yesterday), AI-grades anything that just closed, drains any new option assignments.\n\n" +
      'Use it when you know something just happened on Alpaca and don\'t want to wait ~5 min for the ' +
      'next cron tick — e.g. right after using the Import from Alpaca button, or when the bot closed ' +
      "a position and you'd like the dashboard to catch up immediately.\n\n" +
      'Throttled to once per 15s (button shows a countdown). Underlying loop is idempotent — repeat ' +
      'clicks no-op cleanly. Inline summary after each run: "N synced · N closed · N assigned · N still open."',
  },
  {
    date: '2026-05-21',
    category: 'feature',
    title: 'Changelog page added (this one)',
    details:
      'New /changelog route renders a hand-curated history of every shipped change. ' +
      'Discipline: add a new entry at the top whenever we ship something — bot config tweak, ' +
      'dashboard feature, bug fix, anything user-facing. Bot state-update commits do NOT belong here.\n\n' +
      'Reachable from the small "changelog" link above the sign-out button in the sidebar.',
  },
  {
    date: '2026-05-21',
    category: 'fix',
    title: 'Dashboard detects bot-closed trades + can import positions opened on Alpaca',
    details:
      'Two related trade-tracking issues fixed:\n\n' +
      '(1) NVTS case: when the bot bought-to-close a user-opened CSP at 50% profit, the dashboard ' +
      'never noticed and the trade stayed "open" forever. New Path 3 in detectClose checks Alpaca ' +
      'positions; if the contract is gone (and not past expiry), walks account activities to find ' +
      "the closing fill and marks the trade closed with closed_by: 'bot_external'. Works for " +
      'options + spreads (both legs must be gone). Stocks deferred.\n\n' +
      "(2) AAL case: a spread opened directly on Alpaca's web UI (before the dashboard spread " +
      'form existed) had no dashboard record at all. New "Import from Alpaca" button at the bottom ' +
      'of /settings → walks FILL activities since a chosen date and creates trade records for ' +
      'opening fills that don\'t already have one. Spreads paired by underlying+expiration+timestamp. ' +
      'After import, Fix #1 closes them automatically on the next cron tick.\n\n' +
      'Critical for the manual account now that auto_open_spreads is enabled — bot-opened spreads ' +
      'need their closes detected too.',
  },
  {
    date: '2026-05-21',
    category: 'config',
    title: 'Manual paper: auto_open_spreads enabled as $10k SM-engine validation shortcut',
    details:
      "Rather than wait a week for SM (sm500/sm1000/sm2000) to validate before standing up a " +
      'fourth $10k paper account, flipped auto_open_spreads on the existing manual account. ' +
      'Already has $10k seed, auto-discovers symbols, and manages hand-opened spreads — adding ' +
      'auto-open piggybacks on all that plumbing.\n\n' +
      'Opener-side posture mirrors sm1000/sm2000 Balanced (wheelability_min 80, max_risk_pct_equity ' +
      '0.10, min_credit_to_width_pct 0.33, trend_filter, max_concurrent_spreads 4). Management-side ' +
      'rules deliberately UNCHANGED — manual keeps its legacy 50%-of-max-loss stop for ALL spreads ' +
      'so existing user-opened positions (like the AAL put credit) are not retroactively tightened ' +
      'mid-trade onto the SM 2× credit stop.\n\n' +
      'Mixes bot-opens with hand-opens on the same account. To tell them apart: bot-opened spreads ' +
      'carry an open_order_id, hand-opened/adopted spreads have open_order_id=null. The sidebar ' +
      'manual chip shows a ⚙ marker and a one-line footer notes the start date.',
  },
  {
    date: '2026-05-21',
    category: 'config',
    title: 'sm500 wheelability floor 85 → 75 (pool-expansion adjustment)',
    details:
      "Same-day follow-up to the universe expansion. First-day post-expansion logs showed sm500's " +
      'best scores clipping at 77.8 — never reaching the 85 floor. The percentile-rank math means ' +
      'expanding the pool 12 → 52 made the same "best survivor" score LOWER (more competition), ' +
      "not higher. The 85 floor was calibrated for 12 names and became unreachable.\n\n" +
      'Dropped to 75 = top ~25% of cycle\'s eligible candidates. The 40% credit-to-width gate, ' +
      '2× credit stop, trend filter, and underlying tripwire do the actual quality work — ' +
      'wheelability floor is a "don\'t take an obviously bad shot" guard.',
  },
  {
    date: '2026-05-21',
    category: 'engine',
    title: 'SM universe 12 → 52 names; wheelability floor 85 → 80 (sm1000/sm2000); sm500 risk cap 10% → 20%',
    details:
      'First trading day under the hardened SM engine generated zero opens. Inspection showed two ' +
      'structural blockers: the 12-name curated pool was too small for percentile-90 to mean ' +
      "anything (top scorers clipped at 81.8 vs 85 floor), and sm500's 10% cap ($50 max loss) " +
      "couldn't fit ANY $1-wide spread (~$80–95 net max loss).\n\n" +
      'Fixes (no behavioral guardrails relaxed):\n\n' +
      '• SM_CURATED_UNIVERSE 12 → 52 names. Mega-cap tech, more semis, broader energy/pharma/' +
      'staples/telecom/airlines/materials. Names that bled or are persistently declining stay ' +
      'excluded (NIO, NCLH, HPQ, KSS, HPE, RIVN, M, etc.). AAL re-included on user override.\n\n' +
      '• wheelability_min 85 → 80 on sm1000/sm2000 (sm500 left at 85 initially; later dropped to ' +
      '75 same day).\n\n' +
      '• max_risk_pct_equity 10% → 20% on sm500 only. sm1000/sm2000 stay at 10%.',
  },
  {
    date: '2026-05-19',
    category: 'engine',
    title: 'SM engine hardening pass — 4 structural fixes after $280 bleed',
    details:
      'After SM accounts bled −$280 / −8% across two trading days, four structural faults were ' +
      'identified and hardened:\n\n' +
      '1. Credit-to-width floor — reject candidates whose net_credit/width < threshold ' +
      '(0.33 Balanced / 0.40 Conservative). Was no floor.\n\n' +
      '2. Best-ratio width selection — pick highest payoff/risk width across all acceptable ' +
      'candidates instead of breaking on the narrowest.\n\n' +
      '3. 2× credit stop — close at 2× credit (small bounded dollar loss the cron can catch) ' +
      'instead of 50% of max loss. The 50% rule could slip past on illiquid chains.\n\n' +
      '4. Underlying-price tripwire — close immediately if the stock crosses the short strike, ' +
      'independent of option quote quality.\n\n' +
      'Plus: curated universe (12 quality names) replaces the cheap-junk auto-screener path, ' +
      '20-day SMA trend gate added. All SM accounts reset to seed balances and API keys rotated ' +
      'before the hardened engine went live.',
  },
  {
    date: '2026-05-18',
    category: 'feature',
    title: 'Three small-account paper bots go live (sm500, sm1000, sm2000)',
    details:
      "First autonomous, screener-driven, spread-opening engine in the system. Three new paper " +
      'accounts seeded at $500 / $1,000 / $2,000 that manage hand-opened positions like manual ' +
      "BUT also auto-open earnings-screened, risk-capped put credit spreads from a shared screener " +
      'core. Each runs every 10 min on its own cron schedule with separate Alpaca creds, state ' +
      'files, and Discord channels.\n\n' +
      'Posture: percentile-90 wheelability gate, 12% equity risk cap, earnings-excluded, ' +
      '≤1 spread/cycle. sm500 also filters to ≤$25 underlyings.',
  },
  {
    date: '2026-05-16',
    category: 'ui',
    title: 'Small-account dashboard registration + group-view account selector',
    details:
      'Three SM accounts registered across every dashboard enumeration site (account selector, ' +
      "alpaca client factory, rule-check, etc.). New group chips replace the old 'both' hardcoding:\n\n" +
      '• small = sm500 + sm1000 + sm2000\n' +
      '• core = conservative + aggressive\n' +
      '• hands-on = manual + live\n\n' +
      'Single-account chips and "all" still work. Selecting a group renders those accounts ' +
      'side-by-side on account-aware pages.',
  },
  {
    date: '2026-05-15',
    category: 'feature',
    title: 'Dashboard order-form upgrades: spread parity, payoff chart, live spot, fill-hint',
    details:
      "Four order-entry features:\n\n" +
      '• Spread chip parity — SpreadOrderForm uses the same GradePicker/TagPicker/account chips ' +
      'as StockOrderForm. Live disabled (real-money/bot-only).\n\n' +
      '• Interactive payoff chart — pure leg-based SVG with draggable scrubber + keyboard a11y, ' +
      'wired display-only into all 3 forms.\n\n' +
      '• Live chain spot slider — OptionsChain renders a divider between bracketing strikes that ' +
      'repositions every 5s.\n\n' +
      '• Fill-hint chips — Fast / Balanced / Best price suggestions that write into the limit ' +
      'field. Labeled "estimate — not a guarantee."',
  },
  {
    date: '2026-05-15',
    category: 'ui',
    title: 'Dashboard mobile-responsive pass',
    details:
      'Phone-usable across every page. Slide-in nav drawer, shared .rtable CSS primitive reflows ' +
      '5 tables to stacked cards <768px, modals/forms/charts fitted to narrow viewports. Everything ' +
      '≥768px is byte-for-byte the desktop layout. Terminal aesthetic preserved.',
  },
  {
    date: '2026-05-15',
    category: 'feature',
    title: 'Dashboard spread order form (Phase 4)',
    details:
      '/order/new?spread=put_credit&symbol=X opens a two-leg spread form. Reachable via a ' +
      '"Build Put Credit Spread" button on every /lookup page when the symbol has an options ' +
      'chain. Trade record stores both legs in trade.spread; /trades renders one row per spread; ' +
      '/trade/:id shows a SpreadMetadata card and both strikes as horizontal price lines on the chart.',
  },
  {
    date: '2026-05-14',
    category: 'feature',
    title: 'Spread daily summary (Phase 3)',
    details:
      'daily_summary.py renders a "Wheel — Open Spreads" field with live P&L per spread (computed ' +
      'from current mid of each leg). Applies to all 4 per-mode summaries; non-manual modes hold ' +
      'zero spreads so the field doesn\'t render there.',
  },
  {
    date: '2026-05-14',
    category: 'feature',
    title: 'Spread management on manual paper (Phase 2)',
    details:
      'handle_spread() evaluates three close triggers in priority order, every cycle: 50% profit ' +
      'close, 50% max-loss stop, DTE ≤2 with short ITM. Multi-leg close attempted first via Alpaca ' +
      'mleg; falls back to two individual orders. Orphan-leg handler auto-closes the survivor if ' +
      'one leg disappears mid-trade.\n\n' +
      'Validation in progress on the AAL put credit spread (first real adoption).',
  },
  {
    date: '2026-05-14',
    category: 'feature',
    title: 'Spread detection foundation (Phase 1)',
    details:
      'wheel_strategy.py recognizes put credit + call credit spreads at discovery time by pairing ' +
      'short+long option legs that share underlying, expiration, and option type. Narrowest-width ' +
      'pair wins when multiple pairings are possible. Paired legs adopted into a dedicated ' +
      'spread_active state shape with short_leg + long_leg blocks.',
  },
  {
    date: '2026-05-13',
    category: 'infra',
    title: 'Live REAL-MONEY account wired up + Alpaca SDK migration',
    details:
      "Live account runs the same scripts as manual on separate Alpaca live credentials (NOT " +
      'paper endpoint). Never opens new puts — only manages user-opened positions and sells ' +
      'covered calls on assignment.\n\n' +
      'Simultaneously: all dashboard Alpaca calls migrated off the SDK because ' +
      '@alpacahq/typescript-sdk@0.0.32-preview silently routes live-mode requests to paper-api ' +
      "(Alpaca rejects with 40110000 'not authorized'). Custom alpacaTrade() / alpacaTradeMutation() / " +
      'alpacaData() in _lib/data-api.ts bypass the SDK for trading reads, trading mutations, and ' +
      'market data respectively.',
  },
  {
    date: '2026-05-09',
    category: 'feature',
    title: 'Dashboard Phase 3 — rules, tendencies, calendar, performance, watchlist',
    details:
      'Big release. New pages and systems:\n\n' +
      '• /rules — 7 sections (bot rules, my rules, patterns, tendencies, proposals, cheatsheets, ' +
      'goals) with active rule-checker on order placement (warn for bot rules, hard-block + ' +
      'override-with-reasoning for manual rules).\n\n' +
      '• Tendency-detection cron (Sundays 6pm ET) — 6 deterministic matchers → Sonnet 4.6 ' +
      'plain-English proposal generation.\n\n' +
      '• STO put assignments auto-spawn linked stock trades on the grade-cron with inherited ' +
      'entry_grade + tags (calibration math excludes inherited to avoid double-counting).\n\n' +
      '• /watchlist — quotes + 30d sparklines.\n\n' +
      '• /calendar — month grid, P&L heatmap, expiration overlay.\n\n' +
      '• /performance — 6 panels (equity curve, drawdown, grade scatter, win-rate-by-tag, ' +
      'P&L-by-symbol, time-of-day heatmap).',
  },
  {
    date: '2026-05-07',
    category: 'fix',
    title: 'Trade lifecycle fixes — delayed-fill writeback, modify chain, chart panel',
    details:
      'A real manual-mode trade (Ford $11 put, modified twice $0.08→$0.07→$0.05 before filling) ' +
      'surfaced a bunch of latent issues. Five fixes:\n\n' +
      '• Delayed-fill writeback — grade-cron now sync\'s fill data on every open trade per tick. ' +
      "Before, trades stuck forever showing 'submitted · limit $X' even after Alpaca filled.\n\n" +
      "• Modify chain repointing — Alpaca handles modify by canceling + re-creating with a new " +
      'order id. Modify-order endpoint now repoints alpaca_order_id; syncFillData walks ' +
      'replaces/replaced_by bidirectionally as a defense for externally-modified orders.\n\n' +
      '• Modify history audit trail — modify_history: ModifyEvent[] added to trade schema.\n\n' +
      '• TradeChart panel — fixed two latent bugs (bars endpoint shape + infinite-refetch loop ' +
      'from non-memoized query window). Now adaptive timeframe (5Min/15Min/1Hour by trade age).',
  },
  {
    date: '2026-05-03',
    category: 'feature',
    title: 'Dashboard Phase 2 — manual trading + AI grading',
    details:
      '/settings page, /order/new context-driven form, two-state confirm modal (phosphor below ' +
      'threshold, amber + TOTP re-prompt above), /trade/:id with lightweight-charts v5 markers + ' +
      'timeline + your-grade-vs-AI-grade calibration, /trades history with summary band + ' +
      'filterable/sortable table, modify/cancel actions on /orders.\n\n' +
      'AI grading via Sonnet 4.6 with prompt caching, plain-English no-jargon system prompt, ' +
      'grades on close using entry context + price action. Auto-grade cron runs every 5 min.',
  },
  {
    date: '2026-05-02',
    category: 'feature',
    title: 'Dashboard Phase 1 ships — read-only monitoring + auth + lookup',
    details:
      'Personal trading dashboard goes live at tradingbot-dashboard-blue.vercel.app.\n\n' +
      'Auth: hardcoded password + TOTP + 8 backup codes + KV-backed rate limiting. Bots POST ' +
      'state to /api/bot-state with bearer auth. Read-only pages: Home (account snapshot + ' +
      'equity-curve sparklines), Positions (stocks + options w/ all 5 Greeks + DTE), Orders, ' +
      'Lookup (TradingView chart, options chain, earnings bars, fundamentals, wheelability score, ' +
      'news, watchlist add).\n\n' +
      'Stack: Vite + React 19 + Tailwind v4 + Vercel + Upstash KV. 34 vitest tests.',
  },
  {
    date: '2026-04-29',
    category: 'engine',
    title: 'Dual-mode paper architecture + wheel-stock screener v1',
    details:
      'Two paper accounts now run side-by-side with the same scripts parameterized by --mode:\n\n' +
      '• Conservative — 10 large-caps, 10% OTM puts, 14-28 DTE, 50% close\n' +
      '• Aggressive — priority tier (COIN/MARA/RIOT/SMCI/NVDA/AMD/MU) + fallback tier (boring ' +
      'core), 5% OTM, 7-14 DTE, 60% close. Symbol ORDER controls fill priority.\n\n' +
      'Wheel-stock screener runs Sunday evenings for each mode, posts top candidates to Discord ' +
      'as ideas (does not auto-trade — Tim still picks the universe).\n\n' +
      'Daily summary embed shows head-to-head comparison of the two accounts.',
  },
  {
    date: '2026-04-28',
    category: 'engine',
    title: 'Multi-stock wheel — independent Stage 1/Stage 2 per symbol',
    details:
      'wheel_strategy.py generalized from TSLA-only to a multi-stock list. Each symbol gets its ' +
      'own isolated state (Stage 1 puts / Stage 2 covered calls) keyed by symbol in wheel_state.json. ' +
      'Per-symbol error isolation: if BAC errors out, XOM/KO/etc still process normally.',
  },
  {
    date: '2026-04-15',
    category: 'infra',
    title: 'Initial bot — TSLA wheel + strategy + congress copy on GitHub Actions cron',
    details:
      'Original setup. Three workflows on GitHub Actions cron (later moved to cron-job.org for ' +
      'reliability): tsla-monitor (every 10 min during market hours, runs strategy + wheel), ' +
      'congress-copy (4× day, scrapes politician disclosures and copies trades with -15% stop), ' +
      'daily-summary (4:12 PM ET, posts the day\'s P&L to Discord).\n\n' +
      'TSLA wheel: cash-secured puts ~10% OTM, 14-28 DTE, 50%-profit close, transitions to ' +
      'covered calls on assignment. TSLA strategy: 10 shares baseline + ladder buys at -15%/-25%/-40% ' +
      'and -10% stop loss recalculated after each ladder.',
  },
];
