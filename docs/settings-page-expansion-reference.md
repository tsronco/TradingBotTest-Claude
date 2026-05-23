# Settings page expansion — reference doc (PARKED)

**Status:** Parked. Do not start without re-discussing.
**Last discussed:** 2026-05-23 (Tim wanted it; deferred again because we're still tweaking too much for stable config to make sense yet).
**Earlier discussion:** 2026-05-13 — the original "Deferred — possible v3-era settings page expansion" note in `CLAUDE.md` captures the first-round tradeoff thinking.

## Goal

Move bot and dashboard configuration out of `config.py` / hardcoded constants and into the `/settings` page on the dashboard, so changes can be made without opening source files. Tim wants the same pattern as the new "display name" setting (PR #26), extended to everything that's currently a tweakable variable.

Concrete examples Tim called out in the 2026-05-23 conversation:
- Options chain default strike count (currently hardcoded to 6 on `/lookup`)
- Wheel percentages (OTM %, profit-close %)
- DTE ranges
- "All of the variables we have"

## Storage tiers

Four tiers, each with a different storage strategy. Drawing the lines correctly is the hard part.

| Tier | Examples | Storage | Notes |
|---|---|---|---|
| **1. Dashboard UI prefs** | options chain default strike count, default account view on Home, default chart timeframe on Lookup, default chain filter (puts/calls/both) | KV (Upstash) | Zero bot involvement. Pure frontend reads. Establishes the pattern. |
| **2. Per-symbol manual/live overrides** | "open new puts on AAPL on the live account" (one-off override of the default `wheel_skip_new_puts: True`) | KV, **TOTP-gated on live changes** | First tier where real-money risk enters. Needs a TOTP re-prompt modal on save for any live-account write. |
| **3. Wheel / strategy params per mode** | OTM %, DTE range (min/max), profit-close %, stop-loss %, ladder qty multipliers, account_floor, max_risk_pct_equity, wheelability_min, min_credit_to_width_pct, spread_stop_credit_mult, max_concurrent_spreads, max_opens_per_cycle, earnings_exclusion_days, stale_after_hours, trend_filter, etc. | KV, with fallback to `config.MODES` defaults if KV key missing | Bots must read these at runtime each cycle. New runtime dep from bots → dashboard KV. Live account writes TOTP-gated. |
| **4. Symbol lists + roster + webhooks** | `CONSERVATIVE_SYMBOLS`, `AGGRESSIVE_SYMBOLS`, `SM_CURATED_UNIVERSE`, `DEFAULT_CONSERVATIVE_UNIVERSE`, `POLITICIANS`, `SIZING_TIERS`, Discord webhook URLs | GitHub API commits to `config.py` (dashboard uses a PAT with `repo` scope) | Keeps bot's read path file-based — no runtime KV dependency for the heavy lists. Gives git audit trail. Reversible via `git revert`. Cost: dashboard auth bypass = ability to push to main. |
| **DO NOT MOVE** | `ALPACA_*_API_KEY`, `ALPACA_*_API_SECRET`, `DISCORD_*_WEBHOOK` | Stay in GitHub Actions secrets + Vercel env vars | Per-job isolated. Changed rarely. KV downgrade is unacceptable. |

## Open architectural questions (decide BEFORE coding Tier 2+)

1. **KV read frequency for bots.** Every cycle (every 10 min × 7 accounts = 4,200/day reads, well within Upstash free tier)? Or read once at process start? Per-cycle is safer for fast iteration but adds a network hop. Lean: per-cycle, with a 1-cycle TTL local cache as a stampede guard.
2. **Fallback when KV is unreachable.** Bot must keep trading. Three options:
   - Hard-fail the cycle (safest, but means a KV outage halts trading)
   - Fall back to `config.MODES` defaults (safest for uptime, but a "saved" config might silently revert)
   - Fall back to last-known-good cached values from the previous successful cycle (best of both — needs per-cycle local cache writeback)
   Lean: option 3.
3. **TOTP gate scope.** Just live? Or any change that affects real money (live + any mode where actual orders are placed)? Lean: live only.
4. **Audit trail for KV-stored values.** Git gives this for free on Tier 4. KV doesn't. Do we want a `settings:changelog` KV list that captures every write (who/when/old/new) so it's reviewable on the Settings page?
5. **Per-mode vs per-symbol granularity for Tier 3.** Current `config.MODES` is mode-level. Tim's "per-symbol override" idea (Tier 2) is a different axis. Do we want a single override matrix (mode × symbol → param map) or keep the two tiers separate?
6. **Subagent execution.** Per Tim's durable preference (memory: `feedback_always_subagent.md`), implementation plans use subagent-driven execution. Plan accordingly when sequencing tiers.
7. **Where does the spec live?** `docs/superpowers/specs/<date>-settings-page-expansion-design.md`. Plan goes in `docs/superpowers/plans/`. One plan per tier so each tier merges cleanly on its own.
8. **Cron-job.org schedules.** Currently the bot schedules are configured in `tools/setup_cronjobs.py`. Do they move to the Settings page too? Probably not in v1 — they change so rarely that the source-of-truth cost outweighs the convenience.
9. **Symbol fill-order for aggressive.** The order of `AGGRESSIVE_SYMBOLS` in `config.py` controls BP fill priority (priority tier first, fallback tier second). If symbol lists move to Tier 4 (GitHub commits), the Settings UI needs to preserve list ordering as a first-class concept — not just "add/remove a symbol."

## Phasing (rough)

- **Phase 1 — Tier 1 (UI prefs only).** ~1-2 hours. Establishes the KV pattern, Settings UI scaffolding, test patterns. Self-contained merge. Ship before any bot-touching tier.
- **Phase 2 — Tier 3 (wheel params per mode).** ~4-6 hours. Bots read from KV with fallback semantics. TOTP gate on live writes. Per-mode override UI in Settings. Validates the bot-side read pattern on paper for a week before tier 4.
- **Phase 3 — Tier 2 (per-symbol overrides).** ~3-4 hours. Layers on top of Tier 3 — same KV pattern, finer granularity. TOTP-gated live writes.
- **Phase 4 — Tier 4 (symbol lists + roster + webhooks).** ~4-6 hours. GitHub API write path with PAT. Diff preview UI before commit. Per-list ordering preserved.

Each phase gets its own spec + plan + PR. Each merges cleanly on its own.

## When to revisit

Tim's reason for re-parking on 2026-05-23: "I guess it's not needed yet while we're still tweaking basically everything." Revisit when:
- Bot params have stabilized (the SM-auto-spread engine has been validated for ≥4 weeks without further tuning)
- Tim is doing config edits on the road and `config.py` editing is genuinely painful
- Or: a specific safety scenario makes the case (e.g., needing to flip the live account's `wheel_skip_new_puts` for one symbol from a phone)

Until then: keep tweaking `config.py` directly. This doc waits.
