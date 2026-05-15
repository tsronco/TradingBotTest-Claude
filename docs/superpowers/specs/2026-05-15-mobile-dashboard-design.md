# Mobile Dashboard — Design

> **Standalone dashboard effort.** Independent of the spread-support track. Makes the existing dashboard phone-usable without a redesign — same routes, same data, same terminal aesthetic, just responsive.

**Status:** Design (not yet planned → see companion plan).

## Goal

Make `https://tradingbot-dashboard-blue.vercel.app` fully usable on a phone (primary target: 375–414px portrait, iPhone SE → iPhone 15 Pro Max, plus 360px Android). Tim checks positions / orders / trades and occasionally places a manual order from his phone; today the dashboard is desktop-fixed and the navigation **disappears entirely below 720px with no replacement** — you are stranded on the first page you land on.

Ship: a slide-in nav drawer, table reflow to stacked cards, forms/modals that fit a narrow viewport, and a typography/padding scale. Preserve the terminal look (monospace, ASCII ornaments, CRT scanlines, green phosphor palette) — this is a responsiveness pass, **not** a redesign.

## Non-goals (explicitly deferred)

- **PWA / install-to-homescreen / push / service worker.** Listed as a separate Phase-4 dashboard follow-up in CLAUDE.md. Not in this effort.
- **Mobile-first rebuild.** We keep the desktop layout as the canonical layout and add a phone layer beneath a single breakpoint. No component is rewritten data-first.
- **A separate mobile route tree or component set.** One component renders both; behaviour diverges by CSS/breakpoint, not by a forked tree.
- **Bottom tab bar.** Considered and rejected — 10 nav destinations + a 5-option account filter + sign-out don't fit five tabs, and a native tab bar fights the terminal aesthetic. Slide-in drawer chosen instead.
- **Pixel-perfect visual regression tests.** jsdom has no layout engine; we test drawer/interaction state in vitest and validate layout via a manual device checklist.
- **Landscape-phone or tablet-specific tuning.** Anything `≥ md` keeps today's desktop layout. Tablet just gets the desktop layout early; that is acceptable.
- **Touch gestures (swipe-to-open drawer, pull-to-refresh).** Tap-to-toggle only.
- **Calendar month-grid → agenda-list conversion.** The 7-column month grid stays a grid (calendars are inherently grids); cells shrink and the existing day-drawer carries detail on mobile. A list view is a possible future enhancement, not this effort.

## The single breakpoint

Standardize on Tailwind's **`md` = 768px** as the one phone/desktop line.

- `< 768px` ("mobile"): drawer nav, stacked-card tables, scaled padding/type, stacked form rows.
- `≥ 768px` ("desktop"): today's layout, unchanged.

Today the codebase mixes hand-written CSS media queries in `globals.css` (sidebar hides at `720px`, shrinks at `900px`, card grid collapses at `1180px`) with ~11 sparse Tailwind `md:`/`lg:` prefixes. We consolidate the **navigation/layout** line to `768px` so it matches Tailwind's `md:` and there is exactly one number to reason about. The orthogonal `900px`/`1180px` card-grid media queries are left alone — they govern multi-account card columns, not the phone/desktop split, and already degrade gracefully.

## Architecture

Three layers change; no API, no data model, no new Vercel function (stays 10/12 Hobby cap). Purely frontend + CSS.

### 1. Nav drawer (`AppShell` + `Sidebar` + `globals.css`)

`AppShell` owns a boolean `drawerOpen` state.

- **Top bar** becomes `sticky top-0 z-30` so its controls stay reachable while scrolled. A hamburger button is added at its far left, shown only `< md` (`md:hidden`).
- **Sidebar** is reused **verbatim as a component** — its internal markup (brand, 10 nav rows, account filter, ASCII art, sign-out) does not change except to accept an optional `onNavigate` callback that closes the drawer when a nav row or account button is tapped, and a small tap-target bump on mobile. The positioning wrapper around it is what goes responsive:
  - `≥ md`: in-grid, `static`, exactly as today (220px track; `900px` media query still narrows it to 180px).
  - `< md`: `fixed inset-y-0 left-0 z-50 w-[264px]`, translated off-canvas (`-translate-x-full`) → on-canvas (`translate-x-0`) when `drawerOpen`, with a `fixed inset-0 bg-black/60 z-40` backdrop that closes on tap.
- The grid collapses to a single column `< md` (replacing the `720px` rule, retargeted to `768px`). The `aside.term-sidebar { display: none }` rule at `720px` is **deleted** — visibility is now driven by the translate transform, not `display`.
- Drawer auto-closes on: nav-row tap, account-button tap, route change (`useLocation` effect), backdrop tap, `Escape`. Body scroll locks (`overflow: hidden` on `<body>`) while open.

### 2. Responsive tables → stacked cards (`globals.css` + 6 table sites)

Pattern chosen: **CSS-driven reflow on the existing `<table>` markup**, not a data-model component rewrite. Rationale: these tables render rich JSX cells (router `<Link>`s, ASCII `ProgressBar`, colour-coded spans, option-symbol decomposition). A `display:block` reflow keeps every cell's existing render path intact; a data-first `<ResponsiveTable>` rewrite would re-implement all of that and risk regressions across 6 tables for no readability gain.

A single shared utility class — `.rtable` — added to `globals.css`. On the table wrapper:

- `≥ md`: no effect; normal `<table>`.
- `< md`: `table`, `tbody`, `tr`, `td` → `display: block`; `thead` visually hidden; each `<tr>` becomes a bordered card (`border border-border rounded-sm mb-2 p-3`); each `<td>` becomes a `label : value` line where the label is injected via `td::before { content: attr(data-label) }`. The first/primary `<td>` (symbol) renders as a card header (no label, larger).

Per-table change is mechanical: add `className="rtable"` to the table (or its wrapper) and a `data-label="…"` attribute to each `<td>`. No cell JSX changes. Tables that lack a horizontal-scroll wrapper today (`Trades`, `Watchlist`) get the same treatment — the card reflow removes the need for horizontal scroll entirely `< md`.

Sites:

| File | Table | Cols |
|---|---|---|
| `src/routes/Positions.tsx` | positions | 8 |
| `src/routes/Orders.tsx` | orders | 10 (+ modify/cancel buttons) |
| `src/routes/Trades.tsx` | trades history | 10 |
| `src/routes/Watchlist.tsx` | watchlist | 5 |
| `src/components/performance/PnLBySymbolTable.tsx` | P&L by symbol | sortable |
| `src/components/lookup/OptionsChain.tsx` | options chain | dense Greeks |

`OptionsChain` is a special case: an options chain is genuinely a wide numeric grid and a per-row card stack is poor UX for scanning strikes. It keeps its existing internal horizontal scroll (`.chain-scroll`) and instead gets: a sane mobile default of fewer visible columns (collapse Greeks behind the existing toggle, default off on mobile) and a guaranteed scroll container. Documented as a deliberate exception to the card pattern.

`MonthGrid` (Calendar) keeps its 7-column grid; cells shrink `< md` and show a P&L heat dot instead of a dollar figure, with the existing day-drawer carrying detail on tap. Deliberate compromise, noted in non-goals.

### 3. Forms, modals, charts, scale (the rest)

- **Modals** (`ConfirmModal` `max-w-md`, `OrderEditModal` `max-w-sm`): `w-full max-w-md mx-3 max-h-[90vh] overflow-y-auto` so they never touch screen edges and always scroll on a short viewport.
- **Order forms** (`StockOrderForm`, `OptionOrderForm`, `SpreadOrderForm`): side-by-side input rows become `flex-col md:flex-row`; fixed-width inputs (`w-24`/`w-32`) become full-width `< md`; all interactive controls get a ≥44px tap target on mobile.
- **Charts**: `TradingViewChart` `h-[280px]` → `h-[220px] md:h-[280px]` (already `autosize`+`w-full`). `TradeChart` (lightweight-charts) is `clientWidth`-driven for width but has a fixed height and no resize handler — add a `ResizeObserver` so it reflows on orientation change, height `180 md:200`. `EquityChart` SVG already scales (`svg[data-role=chart]{width:100%;height:auto}`) — no change.
- **Scale sweep**: page padding `p-6 → p-3 md:p-6`; card padding `p-5 → p-3 md:p-5`; oversized titles `text-[44px] → text-[28px] md:text-[44px]`. Base 13px font stays; nothing shrinks below 12px on mobile. Filter/period button rows get `flex-wrap` (most already have `.period-row`/`.footer-ribbon` wrap helpers — extend the pattern to filter bars on `Calendar`/`Performance`/`Trades`).

## File structure

### Frontend (`dashboard/src/`)

| File | Status | Responsibility |
|---|---|---|
| `components/layout/AppShell.tsx` | Modify | `drawerOpen` state; sticky top bar; `md:hidden` hamburger; backdrop; responsive positioning wrapper around `<Sidebar>`; close-on-route-change/Escape; body scroll lock. |
| `components/layout/Sidebar.tsx` | Modify (light) | Accept optional `onNavigate?: () => void`; call it from nav rows + account buttons. Tap-target bump `< md`. Internal structure otherwise unchanged. |
| `styles/globals.css` | Modify | Retarget `720px` layout rule → `768px`; delete `aside.term-sidebar{display:none}`; add `.rtable` reflow block; drawer transition/backdrop helpers; mobile tap-target min-heights; extend filter-bar wrap. |
| `routes/Positions.tsx` | Modify | `.rtable` + `data-label` per `<td>`; padding/title scale. |
| `routes/Orders.tsx` | Modify | `.rtable` + `data-label`; modify/cancel buttons → ≥44px tap; padding scale. |
| `routes/Trades.tsx` | Modify | `.rtable` + `data-label` (also fixes today's missing scroll container); filter bar wrap; padding scale. |
| `routes/Watchlist.tsx` | Modify | `.rtable` + `data-label` (also fixes missing scroll container); padding scale. |
| `components/performance/PnLBySymbolTable.tsx` | Modify | `.rtable` + `data-label`. |
| `components/lookup/OptionsChain.tsx` | Modify | Guarantee scroll container; default Greeks toggle off `< md`; no card reflow (documented exception). |
| `components/calendar/MonthGrid.tsx` | Modify | Cell shrink `< md`; heat dot instead of dollar text on small cells. |
| `routes/Calendar.tsx` | Modify | Filter bar `flex-wrap`/stack; padding scale. |
| `components/order/ConfirmModal.tsx` | Modify | `w-full max-w-md mx-3`; verify scroll. |
| `components/order/OrderEditModal.tsx` | Modify | `w-full max-w-md mx-3 max-h-[90vh] overflow-y-auto`; tap targets. |
| `components/order/StockOrderForm.tsx` | Modify | Stack rows `< md`; full-width inputs; tap targets. |
| `components/order/OptionOrderForm.tsx` | Modify | Same. |
| `components/order/SpreadOrderForm.tsx` | Modify | Same; two-leg picker stacks `< md`. |
| `components/lookup/TradingViewChart.tsx` | Modify | Responsive height. |
| `components/trade/TradeChart.tsx` | Modify | `ResizeObserver` + responsive height. |
| `routes/Home.tsx` `routes/Lookup.tsx` `routes/Performance.tsx` `routes/TradeDetail.tsx` `routes/OrderNew.tsx` `routes/Settings.tsx` `routes/Rules.tsx` `routes/RulesEdit.tsx` | Modify (light) | Padding/title scale; button-row wrap. Card grids on Home/Performance already collapse via existing media queries — no structural change. |

### Tests (`dashboard/tests/`)

| File | Status | Responsibility |
|---|---|---|
| `tests/components/AppShell.test.tsx` | Create | Drawer state behaviour (default closed, hamburger toggles, backdrop closes, route change closes, Escape closes, `onNavigate` fires). |
| existing 351 vitest | Run | No-regression gate — markup-only additions (`data-label`, wrapper classes) must not break existing route/component assertions. |

### No-touch (verify only)

- `index.html` — `<meta name="viewport">` already correct.
- `EquityChart.tsx` — SVG already scales via `globals.css`.
- All `api/` — no backend change; Vercel function count unchanged at 10/12.

## Testing strategy

jsdom has no layout engine — we **cannot** assert horizontal scroll, pixel widths, or that cards visually stack. So:

- **Unit (vitest):** drawer interaction state machine (the only genuinely testable new logic) + `onNavigate` wiring + no-regression on the existing 351.
- **Manual device checklist (in the plan's validation task):** real-device or devtools-emulated pass at **375×667** (iPhone SE), **390×844** (iPhone 14), **360×800** (Android), covering: every route reachable via drawer; no horizontal page scroll on any route; every table readable as cards; order form submittable; modals fit and scroll; charts render and reflow on rotate.

## Rollout

1. Branch `claude/mobile-dashboard` (already set).
2. Implement per companion plan; `npm test` green (352) before deploy.
3. Deploy: `cd dashboard && npx vercel --prod` (git push does **not** auto-deploy). If deploying from a worktree, `npx vercel link --yes --project tradingbot-dashboard` first (CLAUDE.md worktree gotcha).
4. Manual device checklist on the production URL.
5. Update CLAUDE.md dashboard section noting mobile responsiveness shipped.

## Open questions / accepted compromises

- **OptionsChain stays horizontally scrollable on mobile** — a strike grid is not improvable as a card stack. Accepted.
- **Calendar stays a 7-col grid on mobile** — small cells + day-drawer. Accepted; agenda-list is a future enhancement.
- **Tablet (768–1024px) gets the desktop layout** — acceptable; not separately tuned.
- **Drawer is tap-to-open only** — no swipe gesture. Accepted for scope.
