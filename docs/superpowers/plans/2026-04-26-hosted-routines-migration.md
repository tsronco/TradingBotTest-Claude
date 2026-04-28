---
title: Hosted Routines Migration Plan
date: 2026-04-26
status: DRAFT — for review
review_target: After Tuesday 4/28 results review, or week of May 5–12
---

# Hosted Routines Migration Plan

## The Problem

The TSLA and congress-copy strategies currently run as **local** scheduled tasks via the `mcp__scheduled-tasks` MCP server. Local means:

- They only fire when the laptop is on AND Claude Code is running AND the laptop has internet.
- Tim is on the road 3–4 months at a time. Starlink stays inside the truck cab; the laptop is often not online during market hours (8 AM–3 PM CT).
- Result: the bots silently skip runs and we don't even know they were skipped.

**Goal:** Move the routines to a hosted environment that runs on its own schedule, talks to Alpaca directly, and reports results to Tim's phone — independent of laptop state.

## What We Decided (Summary)

1. **Hosting:** GitHub Actions cron workflows in the existing TradingBotTest-Claude repo.
2. **Notifications:** Multiple Discord channels via webhooks, segmented by domain.
3. **Logging:** Structured log files committed back to the repo so Claude can read them.
4. **Backup notification:** Daily 3 PM CT email summary.
5. **Claude visibility:** Discord MCP server for live read access + log files for historical detail.

Everything below is the detail behind those five decisions.

---

## 1. Hosting: GitHub Actions

**Why GitHub Actions over the alternatives:**

| Option | Cost | Pros | Cons |
|---|---|---|---|
| **GitHub Actions** | Free (private repo, 2,000 min/mo) | Already have GitHub, scripts are already Python, secrets management built in, no server to maintain | 5-min cron granularity minimum, occasional 1–3 min delays |
| Anthropic remote routines (`/schedule`) | Free, but counts against 15/day cap | Zero setup | Cap is too tight for ~16 fires/day across all bots, tied to Claude account |
| SparkedHost backend | Already paying | Always on, full control | Depends on plan supporting cron + Python; more setup |
| Oracle / fly.io / Railway free VPS | Free | Full Linux box, total flexibility | Most setup, more to maintain |

GitHub Actions wins because it's free, requires zero new infrastructure, and the scripts are already in a repo. If we ever outgrow it (we won't — 5 min granularity is fine for these strategies), we migrate later.

### Workflow files needed

Three workflow files in `.github/workflows/`:

| File | Schedule (UTC — must convert from CT) | What it runs |
|---|---|---|
| `tsla-monitor.yml` | `*/30 13-20 * * 1-5` (every 30 min, 8 AM–3 PM CT, Mon–Fri) | `strategy.py` + `wheel_strategy.py` |
| `congress-copy.yml` | `0 13,15,17,19 * * 1-5` (8, 10, 12, 2 PM CT) | `congress-copy/` scripts |
| `daily-summary.yml` | `5 20 * * 1-5` (3:05 PM CT) | New summary script (TBD — see open questions) |

**⚠️ GitHub Actions cron is in UTC**, and CT is UTC-5 during DST (mid-March through early November) and UTC-6 in standard time. We'll need to either:
- Hardcode UTC and manually update twice a year (annoying), OR
- Add a Python guard at the top of each script that exits early if `datetime.now(ZoneInfo("America/Chicago"))` is outside market hours. Recommended.

### Secrets to add to the repo

In repo Settings → Secrets and variables → Actions:

```
ALPACA_API_KEY
ALPACA_API_SECRET
ALPACA_BASE_URL
DISCORD_TSLA_WEBHOOK
DISCORD_CONGRESS_WEBHOOK
DISCORD_SUMMARY_WEBHOOK
DISCORD_ERRORS_WEBHOOK
DISCORD_ACTIONS_WEBHOOK   (optional firehose channel)
EMAIL_FROM_ADDRESS
EMAIL_APP_PASSWORD         (Gmail app password)
EMAIL_TO_ADDRESS           (fattycodes@gmail.com)
```

---

## 2. Discord Channel Structure

Create a private Discord server (just Tim) with this layout:

| Channel | Notification setting on phone | What goes there |
|---|---|---|
| `#tsla-trades` | Only @mentions | TSLA wheel + trailing stop actions, fills, stop-outs, premiums collected |
| `#congress-trades` | Only @mentions | New Gottheimer disclosures detected, copy trades placed, congress-copy stop-outs |
| `#daily-summary` | All messages (push) | 3 PM CT end-of-day P&L for everything |
| `#errors` | All messages (push, with @mention) | API failures, rejected orders, script crashes — anything broken |
| `#all-actions` (optional) | Muted | Mirror of everything for one-scroll review |

**Why segmented channels:**
- Mute the noisy ones, keep push notifications on for `#errors` and `#daily-summary` only.
- At a truck stop: open Discord → glance at `#errors` → if empty, day was clean.
- 3 months from now: "what did the congress bot do in May?" is a scroll through one channel, not a full-text search.

### Message format: Discord embeds, not plain text

Trade messages should use Discord's embed format so they look like colored cards:

- **Green** for profit / successful sell
- **Red** for loss / stop-out
- **Yellow** for pending / order placed but not filled
- **Blue** for informational (e.g., "checked positions, nothing to do")

Each embed has: title (symbol + action), fields (strike, premium, P&L, fill price), timestamp, footer (which script + run time).

This is ~5 extra lines of code per message and dramatically improves at-a-glance triage on a phone screen.

---

## 3. Structured Logging

Discord is the **display** layer. The **source of truth** is structured log files in the repo.

### What gets logged

Every script run appends to a JSON-lines file:

```
logs/tsla.jsonl
logs/congress.jsonl
logs/errors.jsonl
logs/daily-summary.jsonl
```

Each line is a JSON object with at minimum:

```json
{
  "timestamp": "2026-04-27T13:30:12-05:00",
  "script": "wheel_strategy.py",
  "action": "sold_put",
  "symbol": "TSLA",
  "details": { "strike": 400, "premium": 185, "expiry": "2026-05-02" },
  "result": "success",
  "alpaca_order_id": "abc-123",
  "notes": "Selected strike based on 0.30 delta target"
}
```

### Why JSONL

- Append-only, never rewritten — safe for concurrent runs
- One run = one line, easy to grep / parse / pipe into anything
- Claude can read it directly with the Read or Grep tools
- Future-you can build a dashboard from it without touching Discord

### How logs get back to the repo

The GitHub Actions workflow commits the updated logs back to the repo at the end of each run:

```yaml
- name: Commit logs
  run: |
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add logs/
    git diff --staged --quiet || git commit -m "logs: $(date -u +%Y-%m-%d-%H%M)"
    git push
```

**Tradeoff:** This grows the repo over time. Mitigation: monthly archival (move `logs/tsla.jsonl` to `logs/archive/2026-04-tsla.jsonl`). Yearly the repo grows by maybe 50 MB — totally fine.

**Alternative considered:** Supabase table. More robust, queryable, but adds a new dependency and a new failure mode. Logs-in-repo is simpler for v1; we can migrate later if we want SQL queries.

---

## 4. Daily Email Summary

Discord push notifications are great for real-time but bad for "show me yesterday in one screen." A 3 PM CT email gives Tim a permanent, archived, searchable record.

### Email contents

Subject: `[Trading Bot] Daily Summary — {date}`

Body (plain text or simple HTML):

```
TSLA Wheel Strategy
-------------------
- Open positions: 2 puts, 1 covered call
- Premiums collected today: $185
- Premiums collected this week: $620
- Assignments: none
- Notable: ...

TSLA Trailing Stop
------------------
- Stop adjusted on 1 position (new stop: $389.50)
- No stop-outs

Congress Copy Bot
-----------------
- New disclosures detected: 0
- Open copy positions: 3
- P&L today: -$45 (PSX -2.1%)
- Stop-loss triggers today: 0

Errors Today: 0
Total Account Value: $51,247.83 (+$1,247.83 since 4/25)
```

### How it sends

Python `smtplib` + Gmail app password. ~15 lines of code in the daily-summary script. Free, reliable, no third-party service needed.

If Gmail SMTP becomes annoying (it sometimes is), fall back to Resend or SendGrid free tier (100 emails/day).

---

## 5. Claude's Visibility into Discord & Logs

Two channels for Claude to "see" what happened:

### Primary: Read the log files directly

Logs are in the repo. Tim opens Claude Code, asks "why did the wheel script skip selling a put yesterday?", Claude does:

```
Grep "skipped" logs/tsla.jsonl
Read logs/tsla.jsonl (the relevant lines)
```

Full structured detail, faster than Discord, no rate limits.

### Backup: Discord MCP server

For when Tim only has the Discord notification on his phone and wants to ask Claude about it from a different machine that doesn't have the repo cloned:

- Install a community Discord MCP server (e.g. `discord-mcp` from GitHub).
- Create a Discord bot in the dev portal with `Read Messages` permission on the private server.
- Add MCP config to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "discord-mcp"],
      "env": { "DISCORD_BOT_TOKEN": "..." }
    }
  }
}
```

- Claude can then call `discord__list_messages` etc. to pull recent channel content.

Setup: ~15 min one time. Optional — only worth doing if Tim regularly needs to debug from a machine without repo access. Probably skip for v1.

---

## 6. Migration Path

Don't cutover all at once. Run hosted and local in parallel for a week, compare outputs, then disable local.

### Phase 1: Foundation (1 evening, ~2 hrs)
1. Create the private Discord server + 4 channels + webhooks
2. Add all secrets to GitHub repo
3. Update scripts to send Discord notifications (per-script, behind a feature flag env var so local runs don't double-notify yet)
4. Update scripts to write JSONL logs

### Phase 2: GitHub Actions setup (1 evening, ~1 hr)
1. Write the three workflow files
2. Add the log-commit step
3. Trigger manually with `workflow_dispatch` to verify each workflow runs cleanly
4. Verify Discord messages appear, logs commit back

### Phase 3: Parallel run (1 week)
1. Enable cron triggers on the workflows
2. Keep local routines enabled
3. Compare daily — are hosted and local producing the same actions?
4. Watch for: timezone bugs, secret typos, rate limits, missed runs

### Phase 4: Cutover (5 min)
1. Disable the three local routines via `mcp__scheduled-tasks__update_scheduled_task`
2. Keep them around (disabled) for 30 days as a fallback
3. Delete after 30 days of clean hosted operation

### Phase 5: Daily summary email (separate, ~1 hr)
Add the email-sending logic to the daily-summary workflow. Lower priority than getting the trade workflows up, since Discord covers the basics.

---

## Open Questions / Decisions Needed Before Building

1. **Daily summary script doesn't exist yet.** Right now `tsla-wheel-daily-summary` is a routine description, not actual code. We need to write a `daily_summary.py` that pulls position state, computes P&L, formats the email + Discord post.

2. **Where does state live?** Currently `strategy_state.json` and `wheel_state.json` live in the repo and are read/written by the scripts. In GitHub Actions, every run starts with a fresh checkout — so if the script writes to the state file, that change has to be committed back. Same pattern as the logs. Need to decide: commit state alongside logs (simple) or move state to Supabase (more robust, more setup).

3. **Concurrency.** What if two workflows run at the same time and both try to commit? GitHub Actions has a `concurrency:` key that serializes runs of the same workflow. We should set this on every workflow that writes state/logs.

4. **Congress-copy scripts directory layout.** The current `congress-copy/` dir wasn't fully reviewed in this plan. Need to read the actual scripts and confirm they fit the same hosting pattern.

5. **Should we also alert on "nothing happened"?** I.e., a heartbeat ping every fire confirming the script ran successfully even when there's nothing to trade. Probably yes for the first month so we trust the system, then turn off the heartbeats once we're confident.

6. **GitHub free tier limits.** Private repo gets 2,000 Action minutes/month free. Each of our runs is probably ~30 sec. ~16 runs/day × 30 sec × 22 trading days = ~3 hrs/month. Well within limits. Still worth confirming after a week of real usage.

---

## What This Buys Us

- **Independence from laptop/Starlink state** — bots run regardless of where Tim is or what his connection is
- **Reliable notifications** — Discord pushes hit the phone instantly, email gives daily archive
- **Real audit trail** — JSONL logs are forever, queryable, and Claude can read them to debug
- **Free** — GitHub Actions, Discord webhooks, Gmail SMTP all $0
- **Survivable** — if any one piece breaks (Discord down, Gmail blocks, etc.), the others still work

## What It Doesn't Solve

- **Code bugs** — if the wheel script has a logic error, hosting it doesn't fix that
- **Alpaca API changes / outages** — same risk as today
- **Strategy validity** — this is plumbing, not strategy improvement

---

## Decision Point

Review this plan **either tonight or after the Tuesday 4/28 results review**. If the local routines worked cleanly Monday and the counter check confirms we have headroom, we have time to be thoughtful. If the local routines missed runs because the laptop was offline, this plan jumps the priority queue.

Either way: don't build until we've validated the strategies actually work. Hosting a broken bot just makes it broken in more places.
