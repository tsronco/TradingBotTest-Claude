# Mobile Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard fully phone-usable (375–414px portrait primary) without a redesign — slide-in nav drawer, stacked-card tables, fitted forms/modals, scaled type/padding. Terminal aesthetic preserved.

**Architecture:** One breakpoint (`md` = 768px). Frontend + CSS only — no API, no data model, no new Vercel function (stays 10/12 Hobby). Nav: `AppShell` owns a `drawerOpen` boolean; `Sidebar` reused verbatim as drawer content. Tables: a shared `.rtable` CSS block reflows existing `<table>` markup to cards `< md` via `data-label` attrs — no cell JSX rewrite. Forms/modals/charts: width/stack/tap-target fixes.

**Tech Stack:** React 19 · Vite · Tailwind v4 · React Router · vitest + jsdom · Vercel (Vite framework, root `dashboard/`).

**Spec:** [2026-05-15-mobile-dashboard-design.md](docs/superpowers/specs/2026-05-15-mobile-dashboard-design.md)

**Branch:** `claude/mobile-dashboard`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `dashboard/src/components/layout/AppShell.tsx` | Modify | `drawerOpen` state, sticky top bar, `md:hidden` hamburger, backdrop, responsive `<Sidebar>` wrapper, close-on-route-change/Escape, body scroll lock. |
| `dashboard/src/components/layout/Sidebar.tsx` | Modify | Optional `onNavigate?: () => void` fired from nav rows + account buttons; mobile tap-target bump. Structure otherwise unchanged. |
| `dashboard/src/styles/globals.css` | Modify | Retarget `720px`→`768px`; delete `aside.term-sidebar{display:none}`; add `.rtable` reflow + drawer/backdrop helpers + tap-target min-heights + filter-bar wrap. |
| `dashboard/src/routes/Positions.tsx` | Modify | `.rtable` + `data-label`; padding/title scale. |
| `dashboard/src/routes/Orders.tsx` | Modify | `.rtable` + `data-label`; modify/cancel ≥44px; padding scale. |
| `dashboard/src/routes/Trades.tsx` | Modify | `.rtable` + `data-label` (fixes missing scroll wrapper); filter wrap; padding scale. |
| `dashboard/src/routes/Watchlist.tsx` | Modify | `.rtable` + `data-label` (fixes missing scroll wrapper); padding scale. |
| `dashboard/src/components/performance/PnLBySymbolTable.tsx` | Modify | `.rtable` + `data-label`. |
| `dashboard/src/components/lookup/OptionsChain.tsx` | Modify | Guarantee scroll container; Greeks toggle defaults off `< md`. Documented card-pattern exception. |
| `dashboard/src/components/calendar/MonthGrid.tsx` | Modify | Cell shrink `< md`; heat dot instead of dollar text on small cells. |
| `dashboard/src/routes/Calendar.tsx` | Modify | Filter bar wrap/stack; padding scale. |
| `dashboard/src/components/order/ConfirmModal.tsx` | Modify | `w-full max-w-md mx-3`. |
| `dashboard/src/components/order/OrderEditModal.tsx` | Modify | `w-full max-w-md mx-3 max-h-[90vh] overflow-y-auto`; tap targets. |
| `dashboard/src/components/order/StockOrderForm.tsx` | Modify | Stack rows `< md`; full-width inputs; tap targets. |
| `dashboard/src/components/order/OptionOrderForm.tsx` | Modify | Same. |
| `dashboard/src/components/order/SpreadOrderForm.tsx` | Modify | Same; two-leg picker stacks. |
| `dashboard/src/components/lookup/TradingViewChart.tsx` | Modify | `h-[220px] md:h-[280px]`. |
| `dashboard/src/components/trade/TradeChart.tsx` | Modify | `ResizeObserver` + `180 md:200` height. |
| `dashboard/src/routes/{Home,Lookup,Performance,TradeDetail,OrderNew,Settings,Rules,RulesEdit}.tsx` | Modify (light) | Padding/title scale; button-row wrap. |
| `dashboard/tests/components/AppShell.test.tsx` | Create | Drawer state behaviour. |

**No new Vercel functions. No API/backend change. No data-model change.**

---

## Phase A — Breakpoint baseline + nav drawer (unblocks everything)

### Task A1: Retarget the layout breakpoint to 768px

**Files:** Modify `dashboard/src/styles/globals.css`

- [ ] **Step 1: Edit the responsive breakpoint block**

In `globals.css`, the `/* responsive breakpoints */` block currently reads:

```css
@media (max-width: 900px) {
  .shell-grid { grid-template-columns: 180px 1fr !important; }
}
@media (max-width: 720px) {
  .shell-grid { grid-template-columns: 1fr !important; }
  aside.term-sidebar { display: none; }
}
```

Change to:

```css
@media (max-width: 900px) {
  .shell-grid { grid-template-columns: 180px 1fr !important; }
}
@media (max-width: 767px) {
  .shell-grid { grid-template-columns: 1fr !important; }
  /* sidebar visibility is now driven by the drawer transform in AppShell,
     NOT display:none — see .term-sidebar mobile rules below */
}
```

Leave the `1180px` `#cards` rule untouched.

- [ ] **Step 2: Manual verify**

`cd dashboard && npm run dev`, open at 760px wide → grid is single-column, sidebar still rendered (no `display:none`). Desktop ≥768px unchanged. (Drawer behaviour comes in A2–A3; here we only confirm nothing regressed and the sidebar is no longer hard-hidden.)

---

### Task A2: Sidebar accepts an `onNavigate` close callback

**Files:** Modify `dashboard/src/components/layout/Sidebar.tsx`; Test via Task A4 (`AppShell.test.tsx`)

- [ ] **Step 1: Add the optional prop**

Change the component signature:

```tsx
export default function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
```

- [ ] **Step 2: Fire it from nav rows + account buttons + sign-out**

- On each `<NavLink>` add `onClick={onNavigate}` (in addition to its existing render-prop children — `onClick` on `NavLink` is independent of the `className`/children render props).
- On each account `<button>` add `onNavigate?.()` at the end of the existing `onClick` (after `setMode(o.value)`).
- On the sign-out button leave as-is (it already navigates away via `window.location`).

No structural/markup change otherwise — the drawer reuses this component verbatim.

- [ ] **Step 3: Mobile tap-target bump**

The nav rows are `py-1.5` (~28px tall) — fine for a mouse, tight for a thumb. Add `max-md:py-2.5` to the `navrow` className string and `max-md:py-2` to the `acct-btn` rows so they clear ~40px `< md`. Desktop spacing unchanged.

- [ ] **Step 4: Verify build**

`cd dashboard && npx tsc -p tsconfig.app.json --noEmit` → no errors. (Existing Sidebar has no dedicated test; behaviour is asserted via AppShell in A4.)

---

### Task A3: AppShell — drawer state, hamburger, backdrop, responsive Sidebar wrapper

**Files:** Modify `dashboard/src/components/layout/AppShell.tsx`, `dashboard/src/styles/globals.css`

- [ ] **Step 1: Add drawer state + effects to `AppShell`**

In `AppShell()`:

```tsx
const [drawerOpen, setDrawerOpen] = useState(false);

// close on route change
useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

// close on Escape; lock body scroll while open
useEffect(() => {
  if (!drawerOpen) return;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
  document.addEventListener('keydown', onKey);
  const prev = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = prev;
  };
}, [drawerOpen]);
```

- [ ] **Step 2: Sticky top bar + hamburger**

Make the top-bar wrapper `sticky top-0 z-30` (add to the existing `above-crt border-b …` div's className). Insert as the **first** child of the inner `flex items-stretch h-7 …` row, before the traffic-light dots:

```tsx
<button
  type="button"
  aria-label="Toggle navigation"
  aria-expanded={drawerOpen}
  onClick={() => setDrawerOpen((o) => !o)}
  className="md:hidden flex items-center px-1 -ml-1 text-mid hover:text-hi"
>
  <span className="text-[14px] leading-none">{drawerOpen ? '✕' : '≡'}</span>
</button>
```

- [ ] **Step 3: Wrap `<Sidebar>` in a responsive positioning shell + backdrop**

Replace the grid block:

```tsx
<div className="above-crt grid shell-grid" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
  <Sidebar />
  <main className="relative min-w-0 overflow-hidden">
    <Outlet />
  </main>
</div>
```

with:

```tsx
<div className="above-crt grid shell-grid" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
  {/* backdrop — mobile only, only when open */}
  {drawerOpen && (
    <div
      className="md:hidden fixed inset-0 bg-black/60 z-40"
      onClick={() => setDrawerOpen(false)}
      aria-hidden="true"
    />
  )}
  <div
    className={`term-sidebar-wrap z-50 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[264px] max-md:transition-transform max-md:duration-200 ${
      drawerOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'
    }`}
  >
    <Sidebar onNavigate={() => setDrawerOpen(false)} />
  </div>
  <main className="relative min-w-0 overflow-hidden">
    <Outlet />
  </main>
</div>
```

> Note: Tailwind v4 supports the `max-md:` variant (applies below the `md` min-width). The wrapper is a normal grid child `≥ md` (occupies the 220px track); `< md` it lifts out of flow to a fixed off-canvas panel. The grid's single-column collapse `< md` (Task A1) means the empty track doesn't matter — the wrapper is `position: fixed` there.

- [ ] **Step 4: globals.css — ensure the fixed drawer has an opaque background**

The sidebar `<aside>` uses `bg-panel/40` (semi-transparent) which is fine in-grid but would let page content bleed through the off-canvas drawer. Add to `globals.css`:

```css
/* off-canvas drawer needs a solid backing on mobile */
@media (max-width: 767px) {
  .term-sidebar-wrap { background: var(--color-bg); box-shadow: 2px 0 12px rgba(0,0,0,0.6); }
  .term-sidebar-wrap aside.term-sidebar { min-height: 100vh; }
}
```

- [ ] **Step 5: Manual verify (real responsive devtools)**

`npm run dev`, devtools at 390px: hamburger visible top-left; tap → drawer slides in over a dimmed backdrop; tap a nav row → navigates AND drawer closes; tap backdrop → closes; Escape → closes; body doesn't scroll behind open drawer. Resize to ≥768px → hamburger gone, sidebar back in-grid, no backdrop. No console errors.

---

### Task A4: Drawer behaviour tests

**Files:** Create `dashboard/tests/components/AppShell.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppShell from '../../src/components/layout/AppShell';

function renderShell(initial = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>HOME_PAGE</div>} />
            <Route path="/positions" element={<div>POSITIONS_PAGE</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AppShell drawer', () => {
  it('drawer starts closed (translate-x-full)', () => {
    renderShell();
    const wrap = document.querySelector('.term-sidebar-wrap')!;
    expect(wrap.className).toContain('-translate-x-full');
  });

  it('hamburger toggles the drawer open', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    expect(document.querySelector('.term-sidebar-wrap')!.className).toContain('translate-x-0');
  });

  it('backdrop click closes the drawer', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    fireEvent.click(document.querySelector('[aria-hidden="true"]')!);
    expect(document.querySelector('.term-sidebar-wrap')!.className).toContain('-translate-x-full');
  });

  it('navigating via a nav row closes the drawer and changes route', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    fireEvent.click(screen.getByText('positions'));
    expect(screen.getByText('POSITIONS_PAGE')).toBeInTheDocument();
    expect(document.querySelector('.term-sidebar-wrap')!.className).toContain('-translate-x-full');
  });

  it('Escape closes the drawer', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.term-sidebar-wrap')!.className).toContain('-translate-x-full');
  });
});
```

- [ ] **Step 2: Run → expect FAIL** (before A2/A3 wired): `cd dashboard && npm test -- tests/components/AppShell.test.tsx`. If A2/A3 already done, expect PASS.

- [ ] **Step 3: Make green.** Adjust selectors only if A3 used different class strings. Do not weaken assertions. Mock any network the existing `Sidebar`/account hook needs (mirror the auth/account mock pattern already used in `dashboard/tests/setup.ts` / existing component tests).

- [ ] **Step 4: Full suite no-regression:** `cd dashboard && npm test` → 351 prior + new file all green.

---

## Phase B — Responsive table reflow (stacked cards)

### Task B1: The shared `.rtable` reflow primitive

**Files:** Modify `dashboard/src/styles/globals.css`

- [ ] **Step 1: Add the `.rtable` block** (after the `.chain-scroll` block)

```css
/* Responsive table → stacked cards below md (768px).
   Markup stays a <table>; cells need data-label="…" for the row labels.
   Desktop (>=768px): no effect, normal table. */
@media (max-width: 767px) {
  .rtable table, .rtable tbody, .rtable tr, .rtable td { display: block; width: 100%; }
  .rtable thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .rtable tr {
    border: 1px solid var(--color-border);
    border-radius: 2px;
    margin-bottom: 8px;
    padding: 8px 10px;
    background: rgba(8, 13, 16, 0.6);
  }
  .rtable td {
    border: 0 !important;
    padding: 3px 0 !important;
    text-align: left !important;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .rtable td::before {
    content: attr(data-label);
    color: var(--color-dim);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 10px;
    flex: 0 0 auto;
    align-self: center;
  }
  /* primary cell (symbol) → card header, no label */
  .rtable td[data-primary] { display: block; }
  .rtable td[data-primary]::before { content: none; }
  .rtable td[data-primary] {
    border-bottom: 1px solid var(--color-border) !important;
    padding-bottom: 6px !important;
    margin-bottom: 4px;
    font-size: 13px;
  }
}
```

- [ ] **Step 2: Manual verify with one table later.** No standalone test (pure CSS, jsdom can't assert layout). Verification happens in B2 against `Positions`.

---

### Task B2: Apply `.rtable` to Positions

**Files:** Modify `dashboard/src/routes/Positions.tsx`

- [ ] **Step 1: Add the class.** On the scroll wrapper `<div className="overflow-x-auto">` (line ~162) → `<div className="overflow-x-auto rtable">`.

- [ ] **Step 2: Add `data-label` to every `<td>`** in the body row (lines ~205–243), matching the `<thead>` labels:

| `<td>` | attribute |
|---|---|
| symbol cell | `data-primary` |
| qty | `data-label="qty"` |
| avg cost | `data-label="avg cost"` |
| current | `data-label="current"` |
| mkt value | `data-label="mkt value"` |
| unrealized P/L | `data-label="unrealized P/L"` |
| DTE | `data-label="DTE"` |
| wheel close | `data-label="wheel close"` |

No cell content/JSX changes — attributes only.

- [ ] **Step 3: Page padding/title scale.** `<div className="p-6 max-w-[1480px]">` → `p-3 md:p-6 max-w-[1480px]`. `<h1 className="text-hi text-[44px] …">` → `text-[28px] md:text-[44px]`.

- [ ] **Step 4: Manual verify @ 390px:** each position renders as a bordered card, symbol as header, every other field a `LABEL  value` row, no horizontal scroll, ProgressBar/colored P&L still render. @ ≥768px: identical to before.

- [ ] **Step 5: No-regression:** `cd dashboard && npm test -- Positions` (if a Positions test exists) and full `npm test`. `data-label`/class additions must not break existing assertions.

---

### Task B3: Apply `.rtable` to Orders (incl. tap-target buttons)

**Files:** Modify `dashboard/src/routes/Orders.tsx`

- [ ] **Step 1:** Add `rtable` to the existing `overflow-x-auto` wrapper.
- [ ] **Step 2:** `data-primary` on the symbol cell; `data-label="…"` on the other 9 (submitted, side, type, qty, filled, price, status, DTE, action) matching the headers.
- [ ] **Step 3:** The modify/cancel action buttons: add `max-md:min-h-[40px] max-md:px-3` so they're thumb-tappable in card mode.
- [ ] **Step 4:** Page padding/title scale (`p-3 md:p-6`, title `text-[28px] md:text-[44px]` if present).
- [ ] **Step 5:** Manual verify @ 390px (rows are cards, modify/cancel tappable, modal opens — modal itself fixed in Phase C) + full `npm test` no-regression.

---

### Task B4: Apply `.rtable` to Trades + Watchlist (also fixes their missing scroll wrappers)

**Files:** Modify `dashboard/src/routes/Trades.tsx`, `dashboard/src/routes/Watchlist.tsx`

- [ ] **Step 1 (Trades):** Wrap the `<table>` in `<div className="overflow-x-auto rtable">` (it has none today). `data-primary` on symbol; `data-label` on the other 9 (date, side, qty, entry, exit, P&L, grade, ai, tags). Filter/summary bar above the table: add `flex-wrap` so it doesn't overflow `< md`. Padding scale.
- [ ] **Step 2 (Watchlist):** Same — wrap table in `overflow-x-auto rtable`, `data-primary` on symbol, `data-label` on (price, day %, 30d, action). Padding scale.
- [ ] **Step 3:** Manual verify both @ 390px (cards, no page-level horizontal scroll — confirms the missing-wrapper bug is fixed) + full `npm test` no-regression.

---

### Task B5: Apply `.rtable` to PnLBySymbolTable; handle OptionsChain + MonthGrid exceptions

**Files:** Modify `dashboard/src/components/performance/PnLBySymbolTable.tsx`, `dashboard/src/components/lookup/OptionsChain.tsx`, `dashboard/src/components/calendar/MonthGrid.tsx`

- [ ] **Step 1 (PnLBySymbolTable):** Wrap table in `overflow-x-auto rtable`; `data-primary` on symbol; `data-label` on remaining columns. Sort affordance stays on the (visually-hidden) header — acceptable; mobile users get the default sort. (Optional: add a small `max-md:` sort `<select>` above the cards — defer unless trivial.)
- [ ] **Step 2 (OptionsChain — documented exception):** Do **not** add `.rtable`. Instead: ensure the chain `<table>` is inside a guaranteed `overflow-x-auto` (it uses `.chain-scroll` — verify the element with `.chain-scroll` actually has `overflow-x:auto` and a bounded width on mobile; add `max-w-full` if missing). Default the existing Greeks toggle to **off when `< md`** (read `window.matchMedia('(max-width: 767px)').matches` for the initial state only) so the default mobile chain is ~4 columns, not ~9. Leave desktop default unchanged.
- [ ] **Step 3 (MonthGrid):** Add `max-md:` cell shrink: smaller font, reduce per-day padding, and `< md` render the P&L as a colored heat dot (●) instead of the dollar string (keep the dollar in the existing day-drawer on tap). Keep the 7-column grid. The filter bar in `Calendar.tsx` gets `flex-wrap`.
- [ ] **Step 4:** Manual verify @ 390px: Performance P&L table = cards; Lookup options chain = horizontally scrollable, 4-ish cols by default, Greeks toggle still works; Calendar = readable 7-col grid with heat dots, day-drawer opens on tap. Full `npm test` no-regression.

---

## Phase C — Forms, modals, charts

### Task C1: Modals fit a narrow viewport

**Files:** Modify `dashboard/src/components/order/ConfirmModal.tsx`, `dashboard/src/components/order/OrderEditModal.tsx`

- [ ] **Step 1 (ConfirmModal):** Panel class `max-w-md w-full max-h-[90vh] overflow-y-auto` → add horizontal breathing room: `max-w-md w-full mx-3 max-h-[90vh] overflow-y-auto`. Verify the TOTP re-prompt branch (above-threshold) still fits — its extra input row should stack.
- [ ] **Step 2 (OrderEditModal):** `max-w-sm` → `max-w-md w-full mx-3 max-h-[90vh] overflow-y-auto`. Inputs (qty, limit, stop) → full-width `w-full` `< md`; their row container `flex-col md:flex-row`. Action buttons `max-md:min-h-[44px]`.
- [ ] **Step 3:** Manual verify @ 375px (narrowest target): both modals have a visible margin on both edges, scroll if taller than viewport, all inputs/buttons reachable and tappable. Full `npm test` no-regression (these have component tests — keep them green; selectors are class-agnostic so should pass).

---

### Task C2: Order forms stack on mobile

**Files:** Modify `dashboard/src/components/order/StockOrderForm.tsx`, `dashboard/src/components/order/OptionOrderForm.tsx`, `dashboard/src/components/order/SpreadOrderForm.tsx`

- [ ] **Step 1:** In each form, find horizontal input rows (flex rows with multiple inputs) and fixed-width inputs (`w-24`, `w-32`, `w-[NNpx]`). Change row containers to `flex-col gap-3 md:flex-row md:gap-4`; change fixed-width inputs to `w-full md:w-32` (preserve the desktop width as the `md:` value). Inputs/selects/buttons → `max-md:min-h-[44px]`.
- [ ] **Step 2 (SpreadOrderForm specifically):** the two-leg picker (short strike / long strike side by side) → stack `< md`. `SpreadOrderForm` has an existing test (`tests/components/SpreadOrderForm.test.tsx`) — keep it green; class-only changes shouldn't touch its assertions.
- [ ] **Step 3 (OrderNew route):** padding scale `p-3 md:p-6` on the route wrapper.
- [ ] **Step 4:** Manual verify @ 390px: place a paper stock order end-to-end (fill symbol/qty/price/grade/reasoning, Review → ConfirmModal → submit). Repeat for option + spread forms (no submit needed past Review for those). Full `npm test` no-regression.

---

### Task C3: Charts reflow on mobile

**Files:** Modify `dashboard/src/components/lookup/TradingViewChart.tsx`, `dashboard/src/components/trade/TradeChart.tsx`

- [ ] **Step 1 (TradingViewChart):** the fixed `h-[280px]` container → `h-[220px] md:h-[280px]`. Width/`autosize` already responsive.
- [ ] **Step 2 (TradeChart):** lightweight-charts is created with `width: ref.current.clientWidth, height: 200`. Add a `ResizeObserver` on the container in the existing chart-setup effect that calls `chart.applyOptions({ width: el.clientWidth })` on resize, disconnected in the effect cleanup. Height `200` → `window.matchMedia('(max-width:767px)').matches ? 180 : 200` at create time. (Do not introduce the `new Date()` re-render bug — the spec's known TradeChart query-window memoization stays untouched; we only add a ResizeObserver, no new query keys.)
- [ ] **Step 3:** Manual verify: Lookup chart shorter on phone but full-width; open a TradeDetail on phone, rotate portrait↔landscape → chart width tracks the container (no clipped/overflowing canvas). Full `npm test` no-regression.

---

## Phase D — Scale sweep (padding / titles / button rows)

### Task D1: Per-route padding + title + button-row scale

**Files:** Modify `dashboard/src/routes/{Home,Lookup,Performance,TradeDetail,OrderNew,Settings,Rules,RulesEdit}.tsx` (Positions/Orders/Trades/Watchlist/Calendar already done in B)

- [ ] **Step 1:** For each route's top-level wrapper, `p-6` → `p-3 md:p-6` (and `p-5` → `p-3 md:p-5` on card-like inner wrappers). Oversized hero titles `text-[44px]`/`text-[40px]` → `text-[28px] md:text-[44px]`.
- [ ] **Step 2:** Period/filter/tab button rows that can overflow on a phone → ensure `flex-wrap` (reuse the existing `.period-row`/`.footer-ribbon` pattern from `globals.css`; add the class or `flex-wrap` directly). Specifically check: `Performance` filter bar, `Settings` tab strip, `Rules` section toggles, `Lookup` action-button row.
- [ ] **Step 3:** `Home` and `Performance` multi-account card grids already collapse via the existing `1180px` `#cards` media query — confirm visually, no structural change.
- [ ] **Step 4:** Manual verify each route @ 390px: comfortable edge padding, titles not overflowing, no button row pushing horizontal scroll. Full `npm test` no-regression.

---

## Phase E — Validation, no-regression, deploy

### Task E1: Full suite + typecheck gate

- [ ] `cd dashboard && npx tsc -p tsconfig.app.json --noEmit` → zero errors.
- [ ] `cd dashboard && npm test` → all green (351 prior + AppShell suite). Investigate and fix any existing test that broke from `data-label`/class additions — fix the test only if it asserted on incidental structure; never weaken a behavioural assertion.

### Task E2: Manual device checklist (the real validation — jsdom can't do this)

Run in responsive devtools (or a real phone) at **375×667**, **390×844**, and **360×800**. For EACH viewport:

- [ ] Land on `/` — hamburger visible, no horizontal page scroll.
- [ ] Open drawer → all 10 nav destinations reachable; each navigates and closes the drawer.
- [ ] Account filter in drawer switches mode and closes drawer.
- [ ] `/positions`, `/orders`, `/trades`, `/watchlist`, `/performance` — every table renders as readable stacked cards, **no horizontal page scroll**.
- [ ] `/lookup/SPY` — chart full-width & shorter; options chain horizontally scrollable; "Build Put Credit Spread" button reachable.
- [ ] `/calendar` — 7-col grid legible with heat dots; tapping a day opens the drawer with detail.
- [ ] `/order/new?symbol=F` — form fields stacked & full-width; Review → ConfirmModal fits with edge margin and scrolls; submit a paper order successfully.
- [ ] `/order/new?spread=put_credit&symbol=AAL` — two-leg picker stacked, reaches Review.
- [ ] Open a closed trade `/trade/:id` — chart reflows on rotate; grade panel readable.
- [ ] `/orders` modify modal — opens, fits, inputs tappable, submit/cancel work.
- [ ] Rotate one route portrait↔landscape — no broken layout, charts track width.

### Task E3: Deploy + document

- [ ] `cd dashboard` — if in a git worktree: `npx vercel link --yes --project tradingbot-dashboard` first (CLAUDE.md worktree gotcha).
- [ ] `npx vercel --prod` (git push does NOT auto-deploy).
- [ ] Re-run a trimmed E2 pass against the production URL on a real phone.
- [ ] Update `CLAUDE.md` "Dashboard subproject" section: add a short "Mobile responsiveness shipped 2026-05-15 — drawer nav, stacked-card tables, one `md`=768px breakpoint" note + test count bump.
- [ ] Commit on `claude/mobile-dashboard`, push with `git push -u origin claude/mobile-dashboard`. Do NOT open a PR unless asked.

---

## Risk / rollback

- **Pure frontend + CSS, gated by one breakpoint.** Everything `≥ 768px` is byte-for-byte the desktop layout (changes are all `max-md:`/`md:`-prefixed or below-`767px` media queries). Desktop regression risk is low and caught by the existing 351 tests.
- **Highest-risk change is the `<Sidebar>` positioning wrapper** (fixed/translate). Mitigated by the A4 drawer test suite + manual checklist.
- **Rollback:** revert the branch — no migrations, no schema, no API, no Vercel config change. A bad deploy is undone by redeploying the previous commit (`npx vercel --prod` from prior SHA).
