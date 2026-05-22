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
