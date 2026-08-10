# TradingBotTest-Claude

An automated Alpaca trading sandbox. It runs an options **wheel** strategy, a
trailing-stop/ladder stock strategy, and an optional congressional-trade copier
on a schedule (GitHub Actions + cron-job.org), across several isolated accounts
in parallel. Trade/error/summary notifications go to Discord; structured logs
are committed back to this repo as JSONL. An optional personal web **dashboard**
(Vite + React, deployed to Vercel) sits alongside for read-only monitoring and
manual trade entry.

> ⚠️ **Not financial advice. This is a personal experiment, not a turnkey money
> machine.** It can place real trades with real money via the `live` account.
> Options can lose money quickly. You are responsible for every trade it makes.
> Default to paper accounts (fake money) and stay there until you fully
> understand every strategy.

## Getting started

- **New here? → [QUICKSTART.md](QUICKSTART.md)** — the 6-step minimum path
  (one account + dashboard) in ~50 min, mostly account signups.
- **Fast path — `python setup.py --web`:** create the third-party accounts
  (Alpaca, Discord, GitHub, cron-job.org, optionally Vercel/Anthropic — these
  signups can't be automated), then run the guided installer. `--web` opens a
  local browser UI (or omit it for the terminal wizard); either way it writes
  your `.env` files, fixes the two fork gotchas, bulk-pushes GitHub secrets,
  schedules cron-job.org, and (optionally) creates Discord webhooks + deploys
  the dashboard. See **["The fast path" in instructions.md](instructions.md)**.
- **Manual / reference setup:** see **[instructions.md](instructions.md)** —
  the complete, from-scratch, zero-knowledge guide (fork → Alpaca → Discord →
  GitHub Actions → cron-job.org → optional Vercel dashboard, with a
  minimal-start path and real-money warnings). The wizard automates these
  steps; this is the fallback and the explanation of what each piece does.
- **How it actually works:** see **[CLAUDE.md](CLAUDE.md)** — the authoritative
  architecture reference: every account mode, exact strategy parameters, the
  Discord channel map, the cron schedule, the runbook, and dashboard internals.

## Repository layout

| Path | What it is |
|---|---|
| `strategy.py`, `wheel_strategy.py`, `long_options_strategy.py` | The core bot strategies (mode-parameterized) |
| `config.py` | `MODES` table — credentials, state files, channels, and parameters per account |
| `congress-copy/` | Optional congressional-trade copier (own Python env) |
| `.github/workflows/` | Scheduled jobs (triggered by cron-job.org) |
| `tools/` | Setup + read-only helper scripts (`setup_cronjobs.py`, etc.) |
| `dashboard/` | Optional Vite + React monitoring/manual-trade dashboard |
| `tests/` | Pytest suite — mocks all external services |

## Running the tests

```bash
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest tests/ -q
```

The dashboard has its own suite: `cd dashboard && npm install && npm test`.
