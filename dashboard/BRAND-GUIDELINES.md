# Tim Dash — Brand & Design Guidelines

The dashboard's aesthetic is **Bloomberg Terminal × tmux × neovim**. Everything is monospace, phosphor-green on near-black, with hard ASCII frames and CRT scanlines. The look should feel like a real TUI ported to the web — dense, deliberate, and quietly opinionated.

> **The rule when in doubt:** if it would look at home in a 1996 trader's terminal, it belongs. If it would look at home on a 2024 SaaS landing page, it doesn't.

---

## 1. Color tokens

All tokens live in `dashboard/src/styles/globals.css` (`@theme` block) and are mirrored in `dashboard/tailwind.config.ts`. Use Tailwind utilities (`text-hi`, `bg-panel`, etc.), not hex values directly.

| Token | Hex | Use for |
|---|---|---|
| `bg` | `#05080a` | Page background (near-black with green tint) |
| `panel` | `#080d10` | Card/panel surfaces |
| `panel-2` | `#0d1f17` | Inset elements (input fields, secondary surfaces) |
| `border` | `#143a25` | All hairline borders + ASCII-frame separators |
| `grid` | `#0d1f17` | Chart gridlines, dotted dividers |
| `dim` | `#3d6650` | Quiet labels, placeholders, em-dashes, bracket chars |
| `mid` | `#6f9c83` | Secondary body text (between dim and fg) |
| `fg` | `#a7e0c2` | Primary body text — soft phosphor green |
| **`hi`** | **`#22ff88`** | Phosphor accent — active states, gains, score peaks, conservative account |
| **`amber`** | **`#ffb454`** | Aggressive account, warning states, "next earnings" highlight, intermediate scores |
| **`red`** | **`#ff5c6c`** | Losses, errors, canceled orders, PUT options, out-of-range delta |
| **`cyan`** | **`#5ed3f3`** | Path segments (`~/portfolio`), CALL options, delta sweet-spot (0.28-0.32) |
| `magenta` | `#d36bff` | Reserved (currently unused — available for future feature differentiation) |

Back-compat aliases (`muted`, `text`, `text-strong`, `accent`, `green`) point to the corresponding terminal values so legacy code still renders correctly.

---

## 2. Typography

**One font, one purpose.** JetBrains Mono via Google Fonts, weights 300/400/500/600/700.

```css
font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
font-feature-settings: 'tnum' on, 'lnum' on, 'ss01' on, 'zero' on;
font-variant-numeric: tabular-nums;
letter-spacing: 0.01em;
text-shadow: 0 0 1px rgba(34, 255, 136, 0.18);
```

**Always tabular figures** for any number rendered to the screen. Use the `.tnum` utility on cells/columns showing dollar values, percentages, counts, dates.

**Type scale:**
- Page H1 (`Today` / `Positions` / `Lookup`): `text-[44px] font-bold tracking-tight text-hi`
- Card equity headline: `text-[34px] font-bold tnum text-hi` (or `text-amber` for aggressive)
- Section subtitles: `text-[12px] text-mid` with `text-dim` brackets
- Labels (eyebrow text): `text-[10px] tracking-[0.25em] uppercase text-dim`
- Body: `text-[12px]` or `text-[11px]`
- Small numerics in tables: `text-[12px] tnum`
- Footnotes / status: `text-[10px] text-dim`

---

## 3. Page structure

Every authenticated page follows the same skeleton:

```
┌── tmux top bar (in AppShell) ──────────────────────┐
│ ● ● ●  tmux · tim@dash:~/portfolio  [1:home* ...] │ ← live ET clock right
└────────────────────────────────────────────────────┘
┌── sidebar ─┬── main ─────────────────────────────────────────┐
│ TIM_DASH   │  prompt header                                  │
│ /// SYS    │  tim@dash:~/portfolio$ <verb> --mode=… --range=…│
│            │                                                 │
│ NAV        │  ┌─ title row ──────────────────────────────┐   │
│ ▸ home  [1]│  │  Today                  // subtitle     │   │
│ · positions│  │  [Sun, May 3, 2026]                      │   │
│ · orders   │  └──────────────────────────────────────────┘   │
│ · lookup   │                                                 │
│            │  ━━━ accounts [N] ─────── $ pnl --range 1m      │
│ ACCOUNTS   │                                                 │
│ ▸ both [a] │  <main content — cards / tables>                │
│ · cons     │                                                 │
│ · agg      │  ━━━ ledger ───── — press [?] for keymap        │
│            │                                                 │
│ <ASCII art>│  tim@dash:~/portfolio$ █                        │
│            │                                                 │
│ last sync  │                                                 │
│ sign_out ⏻ │                                                 │
└────────────┴─────────────────────────────────────────────────┘
```

Open every page with a **prompt header** containing live `--mode=`, `--range=`, optionally `--interval=` flags. Close every page with a `━━━ ledger` divider and a bottom prompt with blinking caret. This rhythm is non-negotiable.

---

## 4. Card / panel pattern

Cards on every page share the same chrome — an **ASCII corner ornament** anchored top-left:

```jsx
<article className="relative border border-border bg-panel/60 rounded-sm min-w-0" style={{ overflow: 'visible' }}>
  <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
    <span className="text-dim">┌──</span>
    <span className="text-hi">CONSERVATIVE</span>
    <span className="text-dim">──┐</span>
  </div>
  {/* body */}
</article>
```

**Critical:** the parent must be `overflow: visible` so the ornament can hang above the border. Inner rows can be `overflow-hidden` if needed.

For metric grids, use this divider pattern:

```jsx
<div className="px-5 text-dim select-none text-[10px] tnum metrics-rule">
  <div className="flex items-center gap-2 whitespace-nowrap">
    <span>├</span>
    <span className="flex-1 border-t border-dashed border-border min-w-0" />
    <span className="px-1 tracking-[0.25em]">METRICS</span>
    <span className="flex-1 border-t border-dashed border-border min-w-0" />
    <span>┤</span>
  </div>
</div>
```

---

## 5. Buttons

**Period / granularity / filter buttons** use the `.pbtn` utility:

```jsx
<button type="button" className={`pbtn ${isActive ? 'active' : ''}`}>
  [{label}{isActive ? '*' : ''}]
</button>
```

The label is wrapped in literal square brackets (e.g. `[1M*]`), and the active state appends an asterisk. The class handles colors (`text-hi` border + bg when active).

**Primary action button** (form submit): use `pbtn` with phosphor-green styling when valid, default state otherwise. See Login form for the pattern.

---

## 6. Semantic color rules

These are **non-overlapping conventions**. Don't reuse colors out of context.

| Domain | Color rule |
|---|---|
| Conservative account | `text-hi` (phosphor green) — bg dot uses `bg-hi` |
| Aggressive account | `text-amber` — bg dot uses `bg-amber` |
| P&L gains | `text-hi` with `▲` prefix |
| P&L losses | `text-red` with `▼` prefix |
| Order status `filled` | `text-hi` |
| Order status `new`/`accepted`/`pending`/`partially_filled` | `text-amber` (legend says "open") |
| Order status `canceled`/`rejected`/`expired` | `text-red` |
| Order side `buy` | `text-hi` |
| Order side `sell`/`sell_short` | `text-red` |
| Option type `PUT` | `text-red` |
| Option type `CALL` | `text-cyan` |
| Delta proximity to 0.30 (wheel target) | `\|Δ\|` ∈ [0.28, 0.32] = `text-cyan font-semibold`; ∈ [0.25, 0.40] = `text-hi`; outside = `text-red font-bold` |
| Wheelability score | ≥ 70 = `text-hi`, ≥ 40 = `text-amber`, < 40 = `text-red` |
| DTE warning | `text-amber` if ≤ 7 days, otherwise `text-fg` |

When a number is signed (delta, P&L, percent), prefix with `▲` for positive, `▼` for negative, `—` for zero. Replace ASCII `-` in displayed strings with the typographic minus `−` for visual consistency.

---

## 7. Number formatting

- **Currency:** `fmtUsd(n)` from `lib/format.ts`. Always two decimals, comma-grouped, `$` prefix.
- **Percent:** `fmtPct(n)` — two decimals, `+` prefix when `sign: true`. `−` minus, not `-`.
- **Date — option expirations & general dates:** `MM/DD/YYYY` (e.g. `05/22/2026`). Helper: `fmtIsoDateMDY()`.
- **Date — chart hover labels:** depends on period:
  - 1D → `h:mm AM/PM` (e.g. `9:45 AM`)
  - 1W / 1M / 3M → `Mon D` (e.g. `Apr 14`)
  - 1Y → `Mon D, YYYY` (e.g. `May 22, 2025`)
- **Submitted/timestamp in tables:** `MM/DD/YYYY HH:MM` (24h, ET implied)
- **Em-dash placeholders:** when a value is missing or unavailable, render `<span className="text-dim">—</span>`. Not `N/A`. Not blank.
- **Tabular alignment:** every numeric column or readout MUST use `tnum` so digits align across rows.

---

## 8. Visual effects (CSS utilities)

All defined in `globals.css`. Apply with class names — don't reinvent.

| Class | Effect |
|---|---|
| `.crt` | CRT scanlines + faint phosphor radial glow (apply to outermost auth shell) |
| `.vignette` | Darkening at corners (auth shell) |
| `.dotgrid` | Faint phosphor dot pattern (auth shell) |
| `.above-crt` | Gives a child element `z-index: 2` so it sits above CRT pseudo-elements |
| `.caret` | Blinking phosphor cursor (1s steps) |
| `.pulse` | 1.6s opacity pulse (1 ↔ 0.35) — use on live status dots |
| `.tnum` | `font-variant-numeric: tabular-nums` |
| `.hover-label` | Floating crosshair label (chart hover) |
| `.acct-btn` | Sidebar account-filter button styling |
| `.navrow` | Sidebar nav row hover + active state |
| `.pbtn` | Period / filter button (terminal pill) |
| `.metrics-rule` | Card metric divider — clips overflowing dashes |
| `.ascii-row` | Single-line clipper for ASCII frame elements |
| `.period-row` | Flex row that wraps gracefully (period/granularity selectors) |
| `.footer-ribbon` | `━━━ ledger` footer container |

**Never inline scanlines, gradients, or glow effects.** Use the existing classes or extend `globals.css` with a new named utility.

---

## 9. Sidebar account filter (data-mode pattern)

The sidebar's `accounts` panel is a tri-state filter (`both` / `conservative` / `aggressive`) backed by the `useAccount` hook. State is mirrored to localStorage and broadcast via a `dash:account-mode-change` event so all consumers stay in sync.

The Home page sets `data-mode={mode}` on its `#cards` grid container. CSS in `globals.css` hides the non-matching card and expands the survivor:

```css
#cards[data-mode='conservative'] article[data-acct-key='AGG'] { display: none; }
#cards[data-mode='aggressive']  article[data-acct-key='CONS'] { display: none; }
#cards[data-mode='conservative'],
#cards[data-mode='aggressive'] {
  grid-template-columns: minmax(0, 1fr) !important;
}
```

When adding new pages with per-account cards, replicate this pattern: add `data-acct-key="CONS"` / `"AGG"` to each `<article>`, set `data-mode={mode}` on the grid container, done.

---

## 10. Charts

`EquityChart` (in `components/EquityChart.tsx`) is the canonical chart. Conventions:

- **viewBox:** `0 0 600 180`, `preserveAspectRatio="none"` so it fluidly fills the column
- **Axis padding:** 8px horizontal, 12px vertical
- **Y-axis floor:** range never collapses below 1% of max value (prevents micro-noise from filling the chart)
- **Stroke:** `1.5px`, hardcoded color from prop (`#22ff88` for cons, `#ffb454` for agg)
- **Drop-shadow glow:** `filter: drop-shadow(0 0 2px <color>55)` on the line
- **Area fill:** linear gradient from 18% color → 0% transparent
- **Horizontal grid:** 3 dashed lines at 25/50/75% (`stroke="#143a25" stroke-dasharray="2 4"`)
- **End-of-line dot:** 3.5px circle filled with line color, 1px `#05080a` ring, vertical dashed reference line
- **Hover crosshair:** vertical phosphor line + filled dot (3.5px) wrapped in 6px halo, snap-to-nearest-point. Floating dollar label edge-flips to avoid clipping.

Bar-over-bar hover delta is the convention: hover at any point shows the change from the **previous bar**, not from period-start. Cumulative period change lives on a separate `[period] ▲ +$X (+Y%)` line below the chart.

**Sanity smoothing:** if a history point is outside `[0.5×, 1.5×]` of `account.equity`, treat it as a glitch and linearly interpolate between bookends. Pin the last bar to `equity` so the chart's right edge matches the headline. When smoothing kicks in, surface a `▼ N bars smoothed` indicator under the chart.

---

## 11. Voice & writing style

Page titles are Title Case (`Today`, `Positions`, `Orders`, `Lookup`). **Everything else is lowercase**, terminal-flavored:

- Section headers: `━━━ accounts`, `━━━ open`, `━━━ filled (recent)`, `━━━ ledger`
- Status messages: `loading…`, `no recent news.`, `you don't hold TSLA.`, `no open positions.`
- Empty states use a fake terminal command: `tim@dash:~/portfolio$ ls positions/` followed by `total 0 — none`
- Footer hints: `— press [?] for keymap`, `— click symbol to /lookup`
- Header flags: `--mode=both`, `--range=1m`, `--interval=5m`
- Errors: `invalid password or TOTP code.` (lowercase, terminal-style)

Avoid: title-cased button labels, exclamation marks, em-dashes used as decoration (use `·` middot), emojis, "Sign in" → use `▸ sign in`.

**Path conventions in prompts:** `tim@dash` (user@host) `:` `~/portfolio` (path) `$` (prompt). Brand the cyan path color consistently.

---

## 12. Responsive breakpoints

Target desktop-first; mobile is out of scope. Three breakpoints in `globals.css`:

- **≥ 1180px:** full two-column card grid on Home
- **< 1180px:** cards stack vertically (`#cards { grid-template-columns: 1fr }`)
- **< 900px:** sidebar narrows to 180px
- **< 720px:** sidebar hidden entirely

Always use `minmax(0, 1fr)` for grid columns and `min-width: 0` on flex/grid children that contain charts, ASCII frames, or wide content. Without this, content can blow out the column width on Windows/Chrome.

---

## 13. Accessibility & legibility caveats

- Some terminal text (e.g. `text-mid` body copy) sits around 50% relative luminance vs background. Tim drives in a truck and sees this in bright sunlight — when adding new tertiary text, lean toward `text-fg` over `text-mid` if there's any chance someone needs to read it at a glance.
- Hover effects must be functional, not decorative. Tim uses this as a daily tool, not a marketing site.
- `prefers-reduced-motion` is not currently respected — animations (caret, pulse) ignore it. If a future user complains, gate them behind a media query.

---

## 14. Adding new components — quick checklist

1. Wrap in `<article>` with the ASCII corner ornament (Section 4).
2. Use `data-acct-key="CONS"` or `"AGG"` if it's per-account so the sidebar filter works for free.
3. Numbers get `tnum`, dollar values via `fmtUsd`, percents via `fmtPct`.
4. Use `text-fg` / `text-mid` / `text-dim` hierarchy. Avoid introducing new colors.
5. Use `▸` for active markers, `·` for inactive, `▲▼` for signed deltas, `─│┌┐└┘├┤` for ASCII frames.
6. Replace ASCII `-` with `−` in user-facing strings.
7. Ensure no console errors on render. The `ErrorBoundary` is the safety net — don't rely on it.
8. Use the existing `pbtn` utility for any toggle/filter button. Don't roll your own.

---

## 15. References

- `dashboard/src/styles/globals.css` — the source of truth for all design tokens, utilities, and CSS effects
- `dashboard/tailwind.config.ts` — Tailwind theme mirror
- `dashboard/src/routes/Home.tsx` — canonical example of page structure, prompt header, ASCII divider, footer ribbon
- `dashboard/src/components/account/AccountCard.tsx` — canonical card with header, period selector, chart, hover state, metric grid
- `dashboard/src/routes/Positions.tsx` — canonical terminal-styled table with row coloring conventions
