# Installer Re-run Secret-Sourcing Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the installer writes the merged `.env` files, make every subsequent apply step source secrets from those files instead of the blank-on-re-run in-memory form — fixing auto-push, dashboard auth, and skipped GitHub secrets on a re-run in one coherent change.

**Architecture:** Add one effective-env derivation point in `WebInstaller._run_apply` (read the written `.env`/`dashboard/.env` after step 1 on a real run; fall back to the form on a dry run since files aren't written), then thread `eff_bot`/`eff_dash` into the four downstream consumers. Consumer method signatures/bodies are unchanged — they just receive the complete dict.

**Tech Stack:** Python 3.14, pytest with `tmp_path`/`monkeypatch` (existing `tests/test_installer_webapp.py` pattern). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-18-installer-rerun-secret-sourcing-design.md`
**Branch:** `claude/automated-installer-setup-aAe09` (extends PR #23). Worktree: `.claude/worktrees/installer-v2-hardening`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tools/installer/webapp.py` | `_run_apply` orchestration | Add effective-env derivation after step 1; thread `eff_bot`/`eff_dash` into steps 3/5/6/7 |
| `tests/test_installer_webapp.py` | web installer tests | Add re-run integration guard + dry-run/first-run regression guards |

Tests run from repo root: `python -m pytest tests/ -v`.

---

## Task 1: Effective-env derivation + consumer threading

**Files:**
- Modify: `tools/installer/webapp.py` — `_run_apply` (the block after step 1 ~line 176, and the consumer calls at ~lines 188, 189, 199, 203, 212-214)
- Test: `tests/test_installer_webapp.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_webapp.py`:

```python
def test_rerun_sources_secrets_from_env_files_not_blank_form(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    denv = tmp_path / "d.env"
    env.write_text(
        "ALPACA_API_KEY=PKlive\nALPACA_API_SECRET=sek\n"
        "ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2\n"
        "GITHUB_ACCESS_TOKEN=ghp_fromfile\n"
        "DISCORD_TSLA_WEBHOOK=https://discord.com/api/webhooks/a\n"
        "DISCORD_SUMMARY_WEBHOOK=https://discord.com/api/webhooks/b\n"
        "DISCORD_ERRORS_WEBHOOK=https://discord.com/api/webhooks/c\n"
        "DISCORD_ACTIONS_WEBHOOK=https://discord.com/api/webhooks/d\n"
        "BOT_PUSH_TOKEN=bpt\nUPSTASH_EMAIL=e@x.com\nUPSTASH_API_KEY=uk\n"
    )
    denv.write_text(
        "DASHBOARD_PASSWORD=secretpw\nTOTP_SECRET=ZZTOTP\n"
        "SESSION_SECRET=ss\nBOT_PUSH_TOKEN=bpt\nCRON_TOKEN=ct\n"
        "INTERNAL_FUNCTIONS_TOKEN=ift\n"
    )
    monkeypatch.setattr(webapp, "ENV_PATH", env)
    monkeypatch.setattr(webapp, "DASH_ENV_PATH", denv)
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    monkeypatch.setattr(webapp, "fork",
                        type("F", (), {"apply": staticmethod(lambda *a: [])}))
    monkeypatch.setattr(webapp.validate, "check_alpaca",
                        lambda k, s, u: (True, "ok"))
    monkeypatch.setattr(webapp.WebInstaller, "_run_cron", lambda self: None)

    pushed_secrets, enabled, pushed_token, deployed = [], [], [], {}
    monkeypatch.setattr(webapp.WebInstaller, "_push_secrets",
        lambda self, owner, modes, inc, env_, dry: pushed_secrets.append(env_))
    monkeypatch.setattr(webapp.WebInstaller, "_enable_actions",
        lambda self, owner, env_, dry: enabled.append(env_))
    monkeypatch.setattr(webapp.WebInstaller, "_git_push_fork",
        lambda self, owner, token, dry: pushed_token.append(token))

    def fake_deploy(self, cfg, dash_env_, bot_env_, owner):
        deployed["dash"], deployed["bot"] = dash_env_, bot_env_
    monkeypatch.setattr(webapp.WebInstaller, "_deploy_dashboard", fake_deploy)

    inst = webapp.WebInstaller()
    # Re-run: form is BLANK (re-run-safety leaves already-set fields empty)
    inst._apply({
        "dry_run": False, "owner_repo": "bob/fork",
        "modes": ["conservative"], "include_congress": False,
        "do_dashboard": True, "reset_state": False,
        "bot_env": {}, "dash_env": {},
    })

    assert pushed_secrets[0]["GITHUB_ACCESS_TOKEN"] == "ghp_fromfile"
    assert pushed_secrets[0]["DISCORD_TSLA_WEBHOOK"].endswith("/a")
    assert enabled[0]["GITHUB_ACCESS_TOKEN"] == "ghp_fromfile"
    assert pushed_token[0] == "ghp_fromfile"
    assert deployed["dash"]["DASHBOARD_PASSWORD"] == "secretpw"
    assert deployed["dash"]["TOTP_SECRET"] == "ZZTOTP"
    assert deployed["bot"]["UPSTASH_EMAIL"] == "e@x.com"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Users\fatti\OneDrive\Documents\Coding Files\TradingBotTest-Claude\.claude\worktrees\installer-v2-hardening" && python -m pytest tests/test_installer_webapp.py::test_rerun_sources_secrets_from_env_files_not_blank_form -v`
Expected: FAIL — `pushed_secrets[0]` is `{}` (no `GITHUB_ACCESS_TOKEN`) / `pushed_token[0] == ""` / `deployed["dash"]` lacks `DASHBOARD_PASSWORD`, because the current code passes the blank in-memory `bot_env`/`dash_env`.

- [ ] **Step 3: Add the effective-env derivation**

In `tools/installer/webapp.py` `_run_apply`, locate the end of the step-1 block (the `else:` branch that calls `envfile.write_merged(...)` for `.env` and `dashboard/.env`, ending right before `# 2. fork gotchas`). Insert immediately after that step-1 block and before the `# 2. fork gotchas` comment:

```python
        # After step 1 the .env files are the complete merged truth (form
        # values + already-set keys preserved by write_merged). Every step
        # below must source from that, NOT the in-memory form — the re-run
        # safety UI deliberately leaves already-set fields blank.
        if dry:
            eff_bot, eff_dash = bot_env, dash_env  # files unwritten; preview=form
        else:
            eff_bot = envfile.read_values(ENV_PATH)
            eff_dash = (envfile.read_values(DASH_ENV_PATH)
                        if do_dashboard else {})
```

(`envfile` is already imported at module top; `read_values` already used in `init_state`.)

- [ ] **Step 4: Thread the effective env into the four consumers**

In the same `_run_apply`, make exactly these substitutions (leave everything else byte-identical):

Step 3 — replace:
```python
        self._push_secrets(owner_repo, modes, include_congress, bot_env, dry)
        self._enable_actions(owner_repo, bot_env, dry)
```
with:
```python
        self._push_secrets(owner_repo, modes, include_congress, eff_bot, dry)
        self._enable_actions(owner_repo, eff_bot, dry)
```

Step 5 — replace:
```python
        if do_dashboard and not dry:
            self._deploy_dashboard(cfg, dash_env, bot_env, owner_repo)
```
with:
```python
        if do_dashboard and not dry:
            self._deploy_dashboard(cfg, eff_dash, eff_bot, owner_repo)
```

Step 6 — replace:
```python
            self._git_push_fork(owner_repo, bot_env.get("GITHUB_ACCESS_TOKEN", ""), dry)
```
with:
```python
            self._git_push_fork(owner_repo, eff_bot.get("GITHUB_ACCESS_TOKEN", ""), dry)
```

Step 7 — replace the health-check body:
```python
        if not dry:
            for mode in modes:
                acc = spec.account(mode)
                k = bot_env.get(acc.key_env)
                s = bot_env.get(acc.secret_env)
                u = bot_env.get(acc.url_env, acc.default_url)
                if k and s:
                    ok, msg = validate.check_alpaca(k, s, u)
                    self._log("ok" if ok else "error", f"{mode}: Alpaca {msg}")
```
with:
```python
        if not dry:
            for mode in modes:
                acc = spec.account(mode)
                k = eff_bot.get(acc.key_env)
                s = eff_bot.get(acc.secret_env)
                u = eff_bot.get(acc.url_env, acc.default_url)
                if k and s:
                    ok, msg = validate.check_alpaca(k, s, u)
                    self._log("ok" if ok else "error", f"{mode}: Alpaca {msg}")
```

Do NOT change step 0 (reset), step 1 (the write + its dry-run "would set" preview), `envfile.write_merged`, or any consumer method's own signature/body.

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_installer_webapp.py::test_rerun_sources_secrets_from_env_files_not_blank_form -v`
Expected: PASS

- [ ] **Step 6: Run the full webapp suite (no regression)**

Run: `python -m pytest tests/test_installer_webapp.py -v`
Expected: ALL PASS — including `test_dry_run_apply_writes_nothing_and_logs_plan` (dry-run path uses `eff_*=form`, unchanged), the Task 4/8/13 tests, and the push tests.

- [ ] **Step 7: Commit**

```bash
git add tools/installer/webapp.py tests/test_installer_webapp.py
git commit -m "fix(installer): source secrets from written .env on re-run (not blank form)"
```

---

## Task 2: Regression guards — dry-run + first-run unchanged

**Files:**
- Test: `tests/test_installer_webapp.py` (append)

- [ ] **Step 1: Write the guard tests**

Append to `tests/test_installer_webapp.py`:

```python
def test_dry_run_uses_form_not_files(monkeypatch, tmp_path):
    # A populated .env exists, but dry-run must NOT source from it — it
    # previews only the (form) submission and writes/pushes nothing.
    env = tmp_path / ".env"
    env.write_text("GITHUB_ACCESS_TOKEN=ghp_fromfile\nALPACA_API_KEY=PKfile\n")
    monkeypatch.setattr(webapp, "ENV_PATH", env)
    monkeypatch.setattr(webapp, "DASH_ENV_PATH", tmp_path / "d.env")
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    seen = []
    monkeypatch.setattr(webapp.WebInstaller, "_push_secrets",
        lambda self, o, m, i, env_, dry: seen.append(env_))
    inst = webapp.WebInstaller()
    inst._apply({
        "dry_run": True, "owner_repo": "bob/fork", "modes": ["conservative"],
        "include_congress": False, "do_dashboard": False, "reset_state": True,
        "bot_env": {"ALPACA_API_KEY": "PKform"}, "dash_env": {},
    })
    # dry-run effective env is the FORM, not the file
    assert seen[0] == {"ALPACA_API_KEY": "PKform"}
    assert "GITHUB_ACCESS_TOKEN" not in seen[0]
    assert not env.read_text().count("PKform")  # nothing written in dry-run


def test_first_run_effective_env_equals_written_form(monkeypatch, tmp_path):
    # No pre-existing .env; a full form. After write_merged the file == form,
    # so the effective env equals the form (no behavior change for a clean
    # first-time forker).
    env = tmp_path / ".env"
    monkeypatch.setattr(webapp, "ENV_PATH", env)
    monkeypatch.setattr(webapp, "DASH_ENV_PATH", tmp_path / "d.env")
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    monkeypatch.setattr(webapp, "fork",
                        type("F", (), {"apply": staticmethod(lambda *a: [])}))
    monkeypatch.setattr(webapp.validate, "check_alpaca",
                        lambda k, s, u: (True, "ok"))
    monkeypatch.setattr(webapp.WebInstaller, "_run_cron", lambda self: None)
    seen = []
    monkeypatch.setattr(webapp.WebInstaller, "_git_push_fork",
        lambda self, o, token, dry: seen.append(token))
    monkeypatch.setattr(webapp.WebInstaller, "_push_secrets",
        lambda self, o, m, i, e, d: None)
    monkeypatch.setattr(webapp.WebInstaller, "_enable_actions",
        lambda self, o, e, d: None)
    inst = webapp.WebInstaller()
    inst._apply({
        "dry_run": False, "owner_repo": "bob/fork", "modes": ["conservative"],
        "include_congress": False, "do_dashboard": False, "reset_state": False,
        "bot_env": {"GITHUB_ACCESS_TOKEN": "ghp_form",
                    "ALPACA_API_KEY": "PKf", "ALPACA_API_SECRET": "sf"},
        "dash_env": {},
    })
    assert seen[0] == "ghp_form"  # token from the just-written file == form value
```

- [ ] **Step 2: Run them to verify they pass (behavior already correct after Task 1)**

Run: `python -m pytest tests/test_installer_webapp.py::test_dry_run_uses_form_not_files tests/test_installer_webapp.py::test_first_run_effective_env_equals_written_form -v`
Expected: PASS (these lock the dry-run and first-run behavior the Task 1 derivation already implements).

- [ ] **Step 3: Commit**

```bash
git add tests/test_installer_webapp.py
git commit -m "test(installer): guard dry-run form-only + first-run-unchanged for re-run fix"
```

---

## Task 3: Full suite green

**Files:** none (verification only)

- [ ] **Step 1: Run the installer + cron suite**

Run: `python -m pytest tests/test_installer_upstash.py tests/test_installer_spec.py tests/test_installer_webapp.py tests/test_installer_fork.py tests/test_setup_cronjobs.py tests/test_installer_envfile.py tests/test_installer_wizard.py -v`
Expected: ALL PASS.

- [ ] **Step 2: Run the full bot suite for collateral safety**

Run: `python -m pytest tests/ -q`
Expected: `465 passed` (464 prior + the net new tests added here; 0 regressions). If any pre-existing test regressed, fix the regression before proceeding — do not weaken a test to pass.

- [ ] **Step 3: Commit any regression fixes**

```bash
git add -A
git commit -m "test(installer): reconcile suite with re-run secret-sourcing fix"
```

(If Steps 1–2 were clean with everything already committed in Tasks 1–2, skip this — there is nothing to commit.)

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented by |
|---|---|
| §1 Effective-env derivation (dry vs real) | Task 1 Step 3 |
| §2 Consumer threading (steps 3/5/6/7, signatures unchanged) | Task 1 Step 4 |
| §3 Safety / non-leakage (known-name pulls only) | No code change needed — `_push_secrets` already filters via `spec.github_secret_envs`; `dashboard/.env` is installer-owned. Verified by Task 1's re-run test asserting only expected keys flow. |
| §4 Dry-run guarantee | Task 1 Step 3 (`if dry: eff=form`) + Task 2 `test_dry_run_uses_form_not_files` |
| §Testing 1 — re-run integration guard | Task 1 Step 1 |
| §Testing 2 — dry-run guard | Task 2 `test_dry_run_uses_form_not_files` |
| §Testing 3 — first-run unchanged | Task 2 `test_first_run_effective_env_equals_written_form` |
| §Testing 4 — full suite green | Task 3 |

All spec sections map to tasks. No gaps.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases"/"similar to". Every code step shows complete code; every command has an expected result.

**3. Type consistency:** `eff_bot`/`eff_dash` are plain `dict[str,str]` from `envfile.read_values()` (same shape as the existing `bot_env`/`dash_env`). Consumer signatures are unchanged (`_push_secrets(owner_repo, modes, include_congress, env, dry)`, `_enable_actions(owner_repo, env, dry)`, `_deploy_dashboard(cfg, dash_env, bot_env, owner_repo)`, `_git_push_fork(owner_repo, token, dry)`) — they receive the same positional shapes, just sourced from `eff_*`. The `acc.default_url` fallback on the URL lookup is preserved verbatim in Task 1 Step 4.
