# Installer re-run secret-sourcing fix — design

**Date:** 2026-05-18
**Status:** Approved (brainstorming) — pending written-spec review
**Builds on:** PR #23 (`claude/automated-installer-setup-aAe09`) — installer v2 hardening

## Motivation

The fresh acceptance re-test (2026-05-18) surfaced three failures that share **one root cause**:

1. **Auto-push failed** on a re-run ("Auto-push failed (check git auth/network)").
2. **Dashboard login impossible** — the deployed Vercel project was missing `DASHBOARD_PASSWORD` and `TOTP_SECRET` (they were never pushed).
3. **GitHub Discord/secrets "no value — skipped"** on a re-run; combined with #1 the state-reset never reached the fork, so the fork's scheduled workflows ran on the author's inherited committed wheel state and emitted a flood of bogus trades into the test Discord.

Root cause (confirmed in `webapp.py:147-217`): `_run_apply` derives `bot_env`/`dash_env` from the **in-memory form** (non-empty values only). Step 1 `write_merged` makes the `.env` files the complete merged truth (form values + preserved already-set keys). But every step after step 1 — `_push_secrets`, `_enable_actions`, `_deploy_dashboard`, `_git_push_fork` (token), the health check — consumes the **in-memory form subset**, not the merged files. The v2 re-run-safety feature (Task 8) deliberately instructs users to leave already-set fields blank, so on a re-run those values are absent from the form and every form-only consumer silently loses them — even though they are correctly preserved in the written `.env`.

The Discord flood was a *downstream consequence* of broken auto-push (the reset commit never reached the fork). Fixing the root makes the reset reach the fork, so it is resolved without a separate guard.

## Scope (locked during brainstorming)

**Secret-sourcing root fix only.** One coherent change at the `_run_apply` orchestration level. No per-consumer patches, no bot-level guard, no cron-gating — those were explicitly considered and declined as out of scope (the root fix makes auto-push work, which makes the reset reach the fork, which removes the flood).

## Design

### 1. Effective-env derivation (single point)

In `_run_apply`, immediately after the step-1 write block, derive an *effective* env:

```python
if dry:
    eff_bot, eff_dash = bot_env, dash_env          # files not written; preview = form
else:
    eff_bot = envfile.read_values(ENV_PATH)        # complete post-merge truth
    eff_dash = envfile.read_values(DASH_ENV_PATH) if do_dashboard else {}
```

Step 0 (reset) and step 1 (the write + its dry-run "would set" preview) are **unchanged** — the preview deliberately stays form-based (it previews *this submission*). `envfile.write_merged` is untouched.

### 2. Consumer threading

Replace every post-step-1 use of the form dicts with the effective dicts:

| Step | Before | After |
|---|---|---|
| 3 — GitHub secrets | `_push_secrets(owner_repo, modes, include_congress, bot_env, dry)` | `…, eff_bot, dry)` |
| 3 — enable Actions | `_enable_actions(owner_repo, bot_env, dry)` | `…, eff_bot, dry)` |
| 5 — dashboard deploy | `_deploy_dashboard(cfg, dash_env, bot_env, owner_repo)` | `…, eff_dash, eff_bot, owner_repo)` |
| 6 — auto-push token | `_git_push_fork(owner_repo, bot_env.get("GITHUB_ACCESS_TOKEN",""), dry)` | `…, eff_bot.get("GITHUB_ACCESS_TOKEN",""), dry)` |
| 7 — health check | `bot_env.get(acc.key_env)` / `bot_env.get(acc.secret_env)` / `bot_env.get(acc.url_env, acc.default_url)` | `eff_bot.get(acc.key_env)` / `eff_bot.get(acc.secret_env)` / `eff_bot.get(acc.url_env, acc.default_url)` (the `acc.default_url` fallback is preserved) |

The four consumer methods' signatures and bodies are **unchanged** — they already accept a dict; they simply receive the complete one. `_deploy_dashboard`'s Vercel loop (`for k, v in dash_env.items()`) now iterates the full `dashboard/.env`, so `DASHBOARD_PASSWORD` / `TOTP_SECRET` / `BACKUP_CODES_HASHED` deploy on a re-run (`vercel_cli.set_env` is idempotent — re-pushing unchanged keys is harmless).

### 3. Safety / non-leakage

- `_push_secrets` only pulls known names via `spec.github_secret_envs(modes, include_congress)` then `eff_bot.get(name)` — unrelated keys present in `.env` are never pushed to GitHub.
- `dashboard/.env` is an installer-owned file with a known key set (`spec.dashboard_env_keys`), so iterating it for the Vercel push introduces no stray-key leakage.
- No new secret is read, logged, or transmitted that the installer didn't already handle; the change only makes the *already-intended* set complete on a re-run.

### 4. Dry-run guarantee

In dry-run, `write_merged` is skipped, so `eff_* = bot_env/dash_env` (the form) and step-1's "would set X" preview is byte-identical to current behavior. Dry-run previews *the submission*; real runs act on *the merged result*. This is the single intentional behavioral nuance.

## Testing

Existing `tests/test_installer_webapp.py` pattern (monkeypatch `ENV_PATH`/`DASH_ENV_PATH`/`ROOT` → `tmp_path`, synchronous `inst._apply(cfg)`, mocked `vercel_cli`/`fork`/`github_api`/`subprocess`):

1. **Re-run integration test (core regression guard).** Pre-write a complete `.env` (incl. `GITHUB_ACCESS_TOKEN`, all `ALPACA_*`, Discord webhooks) and `dashboard/.env` (incl. `DASHBOARD_PASSWORD`, `TOTP_SECRET`, `SESSION_SECRET`). Call `_apply` with `cfg.bot_env`/`dash_env` holding only a partial subset (simulating re-run blanks). Assert: GitHub `put_secret` names include the file-only ones (no "no value — skipped" for them); `vercel_cli.set_env` keys include `DASHBOARD_PASSWORD` and `TOTP_SECRET`; the token passed into `_git_push_fork` is non-empty. This single test reproduces and guards all three production symptoms.
2. **Dry-run guard.** `cfg.dry_run=True`, no pre-existing files → nothing written, preview lines form-based and byte-identical to today (keep/extend `test_dry_run_apply_writes_nothing_and_logs_plan`).
3. **First-run unchanged.** No pre-existing `.env`, form fully populated → effective env equals what was written equals the form; secrets/deploy/push behave exactly as before (no regression for a clean first-time forker).
4. Full installer + bot suite stays green (consumer signatures unchanged → no collateral breakage).

## Out of scope / notes

- **Fork-inherits-committed-state design weakness** (the repo commits real bot state to `main`, so forks inherit it) is acknowledged but explicitly **not** addressed here — the root fix makes auto-push work, which makes the reset reach the fork, which removes the observed harm. A structural guard (cron-gating or bot-level self-guard) was considered and declined for this spec.
  - **Footnote (residual, pre-existing):** "no separate guard needed" is true for *this incident's mechanism* (blank-token push failure on a re-run). It is **not** a claim that the flood is now impossible: `_git_push_fork` can still fail to land the reset commit for unrelated reasons (a PAT missing the Workflows scope, or a genuine network/auth failure). Those failure modes leave the fork on inherited committed state and remain a separate, pre-existing path to the same flood symptom — out of scope for this fix, but not silently eliminated by it.
- **Upstash regional-deprecation** was a separate bug already fixed and pushed (`353af0e`).
- Re-validation: a fresh end-to-end acceptance re-test (new throwaway accounts) is the follow-on validation after this fix lands; that test execution is out of scope for this spec.
