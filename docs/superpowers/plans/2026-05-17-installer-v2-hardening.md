# Installer v2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead Vercel-Marketplace Upstash path with Upstash Management-API automation, and fix four installer defects (auto-push auth, re-run footgun, PAT workflow-scope failure, cron-job.org 429 fragility) surfaced by the v1 acceptance test.

**Architecture:** A new `upstash_api.py` module mirrors the existing `discord_api.py`/`github_api.py` integration pattern (typed errors, `dry_run`, idempotent find-or-create). The web installer's `_deploy_dashboard` provisions Redis before the Vercel env push so the dashboard works on the first Apply (no two-pass). The other four fixes are localized edits to `webapp.py`, `github_api.py`, `setup_cronjobs.py`, and `instructions.md`.

**Tech Stack:** Python 3.14, `requests` (already a dep), stdlib `urllib`/`subprocess`, pytest with mocked network (existing `tests/test_installer_*` pattern). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-17-installer-v2-hardening-design.md`

**Branch:** `claude/automated-installer-setup-aAe09` (extends PR #23). Work in worktree `.claude/worktrees/installer-v2-hardening`.

> **Plan-review note (deviation from spec Section 4):** the spec proposed a pre-flight "probe whether the token can write workflow files (API contents probe + token metadata)". There is no reliable GitHub API to assert fine-grained-PAT *workflow-write* before a push (the capability only manifests at push time). This plan implements the spec's *intent* — turn the cryptic failure into an actionable message — via precise **push-failure classification** instead of an unreliable probe, plus the documentation change. Flagging for plan review.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tools/installer/upstash_api.py` | Upstash Management-API client: idempotent DB find-or-create, KV env mapping | **Create** |
| `tools/installer/spec.py` | Credential catalog | Add `UPSTASH_EMAIL`/`UPSTASH_API_KEY` to `GLOBAL_SECRETS`; widen GitHub PAT desc |
| `tools/installer/webapp.py` | Web installer orchestration | Provision Upstash in `_deploy_dashboard`; token-auth + failure-classify in `_git_push_fork`; `_run_cron` exit-code mapping; `init_state` already-set metadata |
| `tools/installer/github_api.py` | GitHub REST helpers | Add pure `is_workflow_scope_error()` |
| `tools/setup_cronjobs.py` | cron-job.org scheduler | Stronger backoff + partial-success exit code 75 |
| `instructions.md` | Forker setup guide | Rewrite Upstash/Marketplace/PAT sections |
| `tests/test_installer_upstash.py` | Upstash module tests | **Create** |
| `tests/test_setup_cronjobs.py` | cron backoff/exit tests | **Create** |
| `tests/test_installer_spec.py` | spec catalog tests | Add Upstash-globals assertions |
| `tests/test_installer_webapp.py` | web installer tests | Add already-set metadata + deploy-provisions-Upstash tests |
| `tests/test_installer_fork.py` | push tests | Add token-auth + no-token-in-config tests |

Tests run from repo root: `python -m pytest tests/ -v`.

---

## Task 1: Upstash module — `find_or_create` + errors

**Files:**
- Create: `tools/installer/upstash_api.py`
- Test: `tests/test_installer_upstash.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_installer_upstash.py`:

```python
"""Upstash Management-API provisioning — all network mocked."""
import pytest

from tools.installer import upstash_api
from tools.installer.upstash_api import UpstashError, UpstashProvisioner


class _Resp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload
        self.text = text
        self.content = b"x" if payload is not None or text else b""

    def json(self):
        return self._payload


def _mock_requests(monkeypatch, handler):
    def fake_request(method, url, **kw):
        return handler(method, url, kw)
    monkeypatch.setattr(upstash_api.requests, "request", fake_request)


def test_reuses_existing_db_by_name(monkeypatch):
    def handler(method, url, kw):
        if method == "GET" and url.endswith("/redis/databases"):
            return _Resp(200, [{"database_name": "tradingbot-dashboard-kv",
                                "database_id": "abc"}])
        if method == "GET" and url.endswith("/redis/database/abc"):
            return _Resp(200, {"database_name": "tradingbot-dashboard-kv",
                               "database_id": "abc", "endpoint": "x.upstash.io",
                               "port": 6379, "rest_token": "T",
                               "read_only_rest_token": "RO", "password": "P"})
        raise AssertionError(f"unexpected {method} {url}")
    _mock_requests(monkeypatch, handler)
    db, plan = UpstashProvisioner("e@x.com", "k").find_or_create()
    assert plan == "existing"
    assert db["rest_token"] == "T"


def test_creates_free_when_absent(monkeypatch):
    def handler(method, url, kw):
        if method == "GET":
            return _Resp(200, [])
        if method == "POST":
            assert kw["json"]["plan"] == "free"
            return _Resp(200, {"database_name": "tradingbot-dashboard-kv",
                               "endpoint": "y.upstash.io", "port": 6379,
                               "rest_token": "FT", "read_only_rest_token": "FRO",
                               "password": "FP"})
        raise AssertionError
    _mock_requests(monkeypatch, handler)
    db, plan = UpstashProvisioner("e@x.com", "k").find_or_create()
    assert plan == "free" and db["rest_token"] == "FT"


def test_free_rejected_falls_back_to_payg(monkeypatch):
    calls = {"post": 0}

    def handler(method, url, kw):
        if method == "GET":
            return _Resp(200, [])
        if method == "POST":
            calls["post"] += 1
            if kw["json"]["plan"] == "free":
                return _Resp(402, text="payment required")
            assert kw["json"]["plan"] == "payg"
            return _Resp(200, {"database_name": "tradingbot-dashboard-kv",
                               "endpoint": "z.upstash.io", "port": 6379,
                               "rest_token": "ZT", "password": "ZP"})
        raise AssertionError
    _mock_requests(monkeypatch, handler)
    db, plan = UpstashProvisioner("e@x.com", "k").find_or_create()
    assert plan == "payg" and calls["post"] == 2


def test_bad_credentials_raise_not_retried(monkeypatch):
    def handler(method, url, kw):
        return _Resp(401, text="unauthorized")
    _mock_requests(monkeypatch, handler)
    with pytest.raises(UpstashError, match="rejected the credentials"):
        UpstashProvisioner("e@x.com", "bad").find_or_create()


def test_dry_run_makes_no_calls(monkeypatch):
    def handler(method, url, kw):
        raise AssertionError("dry-run must not hit the network")
    _mock_requests(monkeypatch, handler)
    db, plan = UpstashProvisioner("e@x.com", "k", dry_run=True).find_or_create()
    assert plan == "free" and db["rest_token"] == "DRYRUN"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_installer_upstash.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.installer.upstash_api'`

- [ ] **Step 3: Write minimal implementation**

Create `tools/installer/upstash_api.py`:

```python
"""Provision the dashboard's Redis (KV) via the Upstash Management API.

Replaces the retired Vercel-Marketplace "free tier" click: the user creates
an Upstash account + a Management API key (Upstash console -> Account ->
Management API); the installer creates (or reuses) one free Redis database
and returns the KV_* env the dashboard's ``Redis.fromEnv()`` needs.

Idempotent: a database whose name matches ``DB_NAME`` is reused, so
re-running the installer never piles up duplicates.
"""
from __future__ import annotations

import requests

API = "https://api.upstash.com/v2"
DB_NAME = "tradingbot-dashboard-kv"
DEFAULT_REGION = "us-east-1"


class UpstashError(RuntimeError):
    pass


class UpstashProvisioner:
    def __init__(self, email: str, api_key: str, *, dry_run: bool = False):
        self.dry_run = dry_run
        self._auth = (email.strip(), api_key.strip())

    def _request(self, method: str, path: str,
                 json: dict | None = None) -> dict | list:
        try:
            r = requests.request(
                method, f"{API}{path}", auth=self._auth, json=json, timeout=30
            )
        except requests.RequestException as e:
            raise UpstashError(f"Upstash API unreachable: {e}") from e
        if r.status_code in (401, 403):
            raise UpstashError(
                "Upstash rejected the credentials. Check the account email "
                "and Management API key (Upstash console -> Account -> "
                "Management API)."
            )
        if r.status_code >= 400:
            raise UpstashError(
                f"{method} {path} -> HTTP {r.status_code}: {r.text[:200]}"
            )
        return r.json() if r.content else {}

    def _find(self, name: str) -> dict | None:
        dbs = self._request("GET", "/redis/databases")
        if isinstance(dbs, list):
            for db in dbs:
                if db.get("database_name") == name:
                    return db
        return None

    def find_or_create(self, name: str = DB_NAME,
                        region: str = DEFAULT_REGION) -> tuple[dict, str]:
        """Return ``(database, plan_used)``.

        ``plan_used`` is ``"existing"`` (reused), ``"free"`` (created free),
        or ``"payg"`` (free rejected, created pay-as-you-go). Bad-credential
        (401/403) errors are never retried as payg.
        """
        if self.dry_run:
            return ({"database_name": name, "endpoint": "dry-run.upstash.io",
                     "port": 6379, "rest_token": "DRYRUN",
                     "read_only_rest_token": "DRYRUN_RO",
                     "password": "DRYRUN"}, "free")
        existing = self._find(name)
        if existing:
            full = self._request(
                "GET", f"/redis/database/{existing['database_id']}"
            )
            return (full if isinstance(full, dict) else existing, "existing")
        body = {"database_name": name, "region": region,
                "plan": "free", "tls": True}
        try:
            db = self._request("POST", "/redis/database", body)
            return (db, "free")  # type: ignore[return-value]
        except UpstashError as e:
            if "-> HTTP 4" not in str(e):
                raise  # bad creds / network / 5xx — not a plan problem
            body["plan"] = "payg"
            db = self._request("POST", "/redis/database", body)
            return (db, "payg")  # type: ignore[return-value]

    @staticmethod
    def kv_env(db: dict) -> dict[str, str]:
        host = db["endpoint"]
        port = db.get("port", 6379)
        pw = db.get("password", "")
        conn = f"rediss://default:{pw}@{host}:{port}"
        return {
            "KV_REST_API_URL": f"https://{host}",
            "KV_REST_API_TOKEN": db["rest_token"],
            "KV_REST_API_READ_ONLY_TOKEN": db.get("read_only_rest_token", ""),
            "KV_URL": conn,
            "REDIS_URL": conn,
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_installer_upstash.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/installer/upstash_api.py tests/test_installer_upstash.py
git commit -m "feat(installer): Upstash Management-API provisioner (idempotent, free→payg fallback)"
```

---

## Task 2: Upstash module — `kv_env` mapping test

**Files:**
- Modify: `tests/test_installer_upstash.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_upstash.py`:

```python
def test_kv_env_maps_dashboard_required_keys():
    db = {"endpoint": "rich-cat-1.upstash.io", "port": 6379,
          "rest_token": "AX", "read_only_rest_token": "RO", "password": "PW"}
    env = UpstashProvisioner.kv_env(db)
    assert env["KV_REST_API_URL"] == "https://rich-cat-1.upstash.io"
    assert env["KV_REST_API_TOKEN"] == "AX"
    assert env["KV_REST_API_READ_ONLY_TOKEN"] == "RO"
    assert env["KV_URL"] == "rediss://default:PW@rich-cat-1.upstash.io:6379"
    assert env["REDIS_URL"] == env["KV_URL"]
    # exactly the five keys the env shape expects, no extras
    assert set(env) == {"KV_REST_API_URL", "KV_REST_API_TOKEN",
                        "KV_REST_API_READ_ONLY_TOKEN", "KV_URL", "REDIS_URL"}
```

- [ ] **Step 2: Run test to verify it passes** (already implemented in Task 1)

Run: `python -m pytest tests/test_installer_upstash.py::test_kv_env_maps_dashboard_required_keys -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/test_installer_upstash.py
git commit -m "test(installer): pin Upstash kv_env mapping contract"
```

---

## Task 3: spec.py — add Upstash globals, widen PAT description

**Files:**
- Modify: `tools/installer/spec.py:148-155` (the `GLOBAL_SECRETS` list)
- Test: `tests/test_installer_spec.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_spec.py`:

```python
def test_upstash_globals_present_and_ask_kind():
    by_name = {n: (k, d) for n, k, d in spec.GLOBAL_SECRETS}
    assert by_name["UPSTASH_EMAIL"][0] == "ask"
    assert by_name["UPSTASH_API_KEY"][0] == "ask"
    # GitHub PAT description must now mention Workflows (push touches workflows)
    gh_desc = by_name["GITHUB_ACCESS_TOKEN"][1]
    assert "Workflows" in gh_desc
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_installer_spec.py::test_upstash_globals_present_and_ask_kind -v`
Expected: FAIL — `KeyError: 'UPSTASH_EMAIL'`

- [ ] **Step 3: Write minimal implementation**

In `tools/installer/spec.py`, replace the `GLOBAL_SECRETS` list (currently lines ~148-155):

```python
GLOBAL_SECRETS = [
    ("GITHUB_ACCESS_TOKEN", "ask", "Fine-grained GitHub PAT (Contents+Actions+Workflows+Administration+Secrets: read/write)"),
    ("CRONJOB_API_KEY", "ask", "cron-job.org API key (Settings -> API)"),
    ("UPSTASH_EMAIL", "ask", "Upstash account email (provisions the dashboard's Redis)"),
    ("UPSTASH_API_KEY", "ask", "Upstash Management API key (console -> Account -> Management API)"),
    ("BOT_PUSH_TOKEN", "generate", "Shared secret: bot -> dashboard /api/bot-state"),
    ("DASHBOARD_CRON_TOKEN", "generate", "Mirrors Vercel CRON_TOKEN (trade-grading cron)"),
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_installer_spec.py -v`
Expected: PASS (all spec tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add tools/installer/spec.py tests/test_installer_spec.py
git commit -m "feat(installer): add UPSTASH_EMAIL/API_KEY globals; note Workflows PAT scope"
```

---

## Task 4: webapp — provision Upstash in `_deploy_dashboard`, drop two-pass

**Files:**
- Modify: `tools/installer/webapp.py` — `_run_apply` step 5 (lines ~182-191), `_deploy_dashboard` signature + body (lines ~320-347)
- Test: `tests/test_installer_webapp.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_webapp.py`:

```python
def test_deploy_dashboard_provisions_upstash_and_drops_two_pass(monkeypatch):
    from tools.installer import upstash_api, vercel_cli

    monkeypatch.setattr(vercel_cli, "available", lambda: True)
    monkeypatch.setattr(vercel_cli, "link", lambda d, p: (True, "linked"))
    set_calls = []
    monkeypatch.setattr(vercel_cli, "set_env",
                        lambda d, k, v: set_calls.append(k) or (True, k))
    monkeypatch.setattr(vercel_cli, "deploy",
                        lambda d: (True, "https://x.vercel.app"))
    monkeypatch.setattr(webapp, "fork",
                        type("F", (), {"apply": staticmethod(lambda *a: [])}))

    class FakeProv:
        def __init__(self, *a, **k): pass
        def find_or_create(self):
            return ({"database_name": "tradingbot-dashboard-kv",
                     "endpoint": "h.upstash.io", "port": 6379,
                     "rest_token": "RT", "password": "PW"}, "free")

    monkeypatch.setattr(upstash_api, "UpstashProvisioner", FakeProv)
    monkeypatch.setattr(webapp.WebInstaller, "_run_cron", lambda self: None)

    inst = webapp.WebInstaller()
    dash_env = {"SESSION_SECRET": "s"}
    inst._deploy_dashboard(
        {"vercel_project": "p", "bot_env": {}},
        dash_env,
        {"UPSTASH_EMAIL": "e@x.com", "UPSTASH_API_KEY": "k"},
        "bob/fork",
    )
    assert "KV_REST_API_URL" in set_calls and "KV_REST_API_TOKEN" in set_calls
    msgs = " ".join(l["msg"] for l in inst.snapshot()["lines"])
    assert "Created free Upstash DB" in msgs
    assert "Marketplace" not in msgs  # two-pass guidance removed
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_installer_webapp.py::test_deploy_dashboard_provisions_upstash_and_drops_two_pass -v`
Expected: FAIL — `TypeError: _deploy_dashboard() takes 4 positional arguments but 5 were given`

- [ ] **Step 3: Write the implementation**

In `tools/installer/webapp.py`, change the call site in `_run_apply` (the `if do_dashboard and not dry:` block, currently lines ~182-191) to:

```python
        # 5. dashboard deploy (provisions Upstash Redis, then deploys)
        if do_dashboard and not dry:
            self._deploy_dashboard(cfg, dash_env, bot_env, owner_repo)
```

(Delete the old `self._log("warn", "One manual step left: ... Upstash Redis ...")` and the following `self._log("info", "After connecting Upstash ...")` lines entirely — the two-pass is gone.)

Replace the `_deploy_dashboard` method (currently lines ~320-347) with:

```python
    def _deploy_dashboard(self, cfg, dash_env, bot_env, owner_repo) -> None:
        from . import vercel_cli
        from .upstash_api import UpstashError, UpstashProvisioner

        if not vercel_cli.available():
            self._log("warn", "Vercel CLI unavailable — deploy manually "
                      "(instructions Step 9).")
            return

        email = bot_env.get("UPSTASH_EMAIL", "")
        api_key = bot_env.get("UPSTASH_API_KEY", "")
        if not (email and api_key):
            self._log("error", "Upstash email + Management API key required "
                      "(the dashboard needs a Redis store). Add them and "
                      "re-Apply.")
            return
        try:
            prov = UpstashProvisioner(email, api_key)
            db, plan = prov.find_or_create()
            dash_env.update(UpstashProvisioner.kv_env(db))
        except UpstashError as e:
            self._log("error", f"Upstash provisioning failed: {e}")
            return
        if plan == "payg":
            self._log("warn", "Upstash free plan unavailable — created a "
                      "pay-as-you-go DB (~$0-$1/mo for this dashboard). Add a "
                      "card at console.upstash.com if it prompts you.")
        elif plan == "existing":
            self._log("ok", "Reusing existing Upstash DB "
                      f"'{db.get('database_name')}'.")
        else:
            self._log("ok", "Created free Upstash DB "
                      f"'{db.get('database_name')}'.")

        proj = cfg.get("vercel_project") or "my-tradingbot-dashboard"
        ok, msg = vercel_cli.link(DASH_DIR, proj)
        self._log("ok" if ok else "warn", f"vercel link: {msg[:160]}")
        for k, v in dash_env.items():
            ok, msg = vercel_cli.set_env(DASH_DIR, k, v)
            self._log("info" if ok else "warn", f"env {msg[:120]}")
        ok, msg = vercel_cli.deploy(DASH_DIR)
        if ok:
            self.dashboard_url = msg
            self._log("ok", f"Deployed: {msg}")
            for c in fork.apply(ROOT, owner_repo, msg):
                self._log("ok", f"Re-pointed {c} at {msg}")
            self._log("info", "Re-syncing cron-job.org with deployed URL…")
            self._run_cron()
        else:
            self._log("error", f"Deploy failed: {msg[:200]}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_installer_webapp.py -v`
Expected: PASS (all webapp tests, including the new one; `test_dry_run_apply_writes_nothing_and_logs_plan` still passes since dry-run never enters `_deploy_dashboard`)

- [ ] **Step 5: Commit**

```bash
git add tools/installer/webapp.py tests/test_installer_webapp.py
git commit -m "feat(installer): provision Upstash before deploy; remove Marketplace two-pass"
```

---

## Task 5: webapp — token-authenticated fork push

**Files:**
- Modify: `tools/installer/webapp.py` — `_run_apply` `_git_push_fork` call site (~line 194) and `_git_push_fork` (lines ~248-302)
- Test: `tests/test_installer_fork.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_fork.py`:

```python
def test_git_push_fork_uses_token_without_persisting(monkeypatch, tmp_path):
    from tools.installer import webapp

    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "setup_cronjobs.py").write_text("# x\n")
    calls = []

    def fake_run(args, **kw):
        calls.append(args)
        class R:
            returncode = 0
            stdout = "main" if args[:2] == ["git", "rev-parse"] else ""
            stderr = ""
        # 'git diff --cached --quiet' must report changes (returncode 1)
        if args[1:4] == ["diff", "--cached", "--quiet"]:
            R.returncode = 1
        return R()

    monkeypatch.setattr(webapp.subprocess, "run", fake_run)
    inst = webapp.WebInstaller()
    inst._git_push_fork("bob/fork", "ghp_SECRET", dry=False)

    push = next(a for a in calls if "push" in a)
    joined = " ".join(push)
    assert "http.https://github.com/.extraheader=AUTHORIZATION: basic " in joined
    assert "ghp_SECRET" not in joined  # raw token never on argv
    # never writes the token into git config
    assert not any(a[1:3] == ["remote", "set-url"] for a in calls)
```

(Note: `webapp._git_push_fork` does `import subprocess` locally; the test patches `webapp.subprocess`. Add a module-level `import subprocess` — Step 3 — so the patch target exists.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_installer_fork.py::test_git_push_fork_uses_token_without_persisting -v`
Expected: FAIL — `AttributeError: module 'tools.installer.webapp' has no attribute 'subprocess'` (no module-level import yet) and signature mismatch (`_git_push_fork` takes `(owner_repo, dry)`)

- [ ] **Step 3: Write the implementation**

In `tools/installer/webapp.py`:

(a) Add a module-level import near the top imports (after `import json`):

```python
import subprocess
```

(b) Change the `_git_push_fork` call in `_run_apply` (currently `self._git_push_fork(owner_repo, dry)`, ~line 194) to:

```python
            self._git_push_fork(owner_repo, bot_env.get("GITHUB_ACCESS_TOKEN", ""), dry)
```

(c) Change the `_git_push_fork` signature and the push loop. Replace the signature line:

```python
    def _git_push_fork(self, owner_repo, token, dry) -> None:
```

Remove the local `import subprocess` and `import time` lines inside the method (subprocess is now module-level; add `import time` to the module-level imports too if not present). Replace the final push-attempt loop (currently `for attempt in range(4): if git("push", "-u", "origin", branch)...`) with:

```python
        import base64
        push_cfg: list[str] = []
        if token:
            blob = base64.b64encode(
                f"x-access-token:{token}".encode()
            ).decode()
            push_cfg = ["-c",
                        "http.https://github.com/.extraheader="
                        f"AUTHORIZATION: basic {blob}"]
        last_err = ""
        for attempt in range(4):
            p = git(*push_cfg, "push", "-u", "origin", branch)
            if p.returncode == 0:
                self._log("ok", f"Committed & pushed fork config to "
                          f"origin/{branch}.")
                return
            last_err = (p.stderr or p.stdout or "")
            if attempt < 3:
                time.sleep(2 ** (attempt + 1))
        self._log("warn", "Auto-push failed (check git auth/network). Your "
                  "commit is saved locally — finish with:  "
                  f"git push -u origin {branch}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_installer_fork.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/installer/webapp.py tests/test_installer_fork.py
git commit -m "fix(installer): authenticate fork push with the held token (no .git/config leak)"
```

---

## Task 6: github_api — workflow-scope error classifier + actionable push warning

**Files:**
- Modify: `tools/installer/github_api.py` (append a pure helper)
- Modify: `tools/installer/webapp.py` — `_git_push_fork` failure branch (from Task 5)
- Test: `tests/test_installer_fork.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_fork.py`:

```python
def test_workflow_scope_error_is_classified():
    from tools.installer.github_api import is_workflow_scope_error

    rej = ("! [remote rejected] b -> b (refusing to allow a Personal Access "
           "Token to create or update workflow `.github/workflows/x.yml` "
           "without `workflow` scope)")
    assert is_workflow_scope_error(rej) is True
    assert is_workflow_scope_error("fatal: Authentication failed") is False


def test_push_failure_emits_workflow_remedy(monkeypatch, tmp_path):
    from tools.installer import webapp

    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "setup_cronjobs.py").write_text("# x\n")

    def fake_run(args, **kw):
        class R:
            returncode = 0
            stdout = "main" if args[:2] == ["git", "rev-parse"] else ""
            stderr = ""
        if args[1:4] == ["diff", "--cached", "--quiet"]:
            R.returncode = 1
        if "push" in args:
            R.returncode = 1
            R.stderr = ("refusing to allow a Personal Access Token to "
                        "create or update workflow `.github/workflows/x.yml` "
                        "without `workflow` scope")
        return R()

    monkeypatch.setattr(webapp.subprocess, "run", fake_run)
    inst = webapp.WebInstaller()
    inst._git_push_fork("bob/fork", "ghp_x", dry=False)
    msgs = " ".join(l["msg"] for l in inst.snapshot()["lines"])
    assert "Workflows: Read and write" in msgs
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_installer_fork.py::test_workflow_scope_error_is_classified tests/test_installer_fork.py::test_push_failure_emits_workflow_remedy -v`
Expected: FAIL — `ImportError: cannot import name 'is_workflow_scope_error'`

- [ ] **Step 3: Write the implementation**

(a) Append to `tools/installer/github_api.py`:

```python
def is_workflow_scope_error(text: str) -> bool:
    """True if a git-push rejection is the fine-grained-PAT workflow-scope
    refusal (vs. generic auth/network failure)."""
    t = (text or "").lower()
    return "workflow" in t and ("scope" in t or "refusing to allow" in t)
```

(b) In `tools/installer/webapp.py` `_git_push_fork`, replace the final
`self._log("warn", "Auto-push failed ...")` (from Task 5 Step 3) with:

```python
        from .github_api import is_workflow_scope_error
        if is_workflow_scope_error(last_err):
            self._log("warn", "Push rejected: your GitHub PAT lacks the "
                      "Workflows permission (the installer rewrites workflow "
                      "files). Fix: edit the fine-grained PAT -> Repository "
                      "permissions -> Workflows: Read and write -> Update "
                      "token, then re-run Apply.")
        else:
            self._log("warn", "Auto-push failed (check git auth/network). "
                      "Your commit is saved locally — finish with:  "
                      f"git push -u origin {branch}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_installer_fork.py -v`
Expected: PASS (all fork tests)

- [ ] **Step 5: Commit**

```bash
git add tools/installer/github_api.py tools/installer/webapp.py tests/test_installer_fork.py
git commit -m "fix(installer): classify workflow-scope push rejection with exact remedy"
```

---

## Task 7: webapp — expose already-set keys (bot + dashboard env)

**Files:**
- Modify: `tools/installer/webapp.py` — `init_state()` (lines ~87-100)
- Test: `tests/test_installer_webapp.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_webapp.py`:

```python
def test_init_state_reports_existing_dashboard_keys(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    denv = tmp_path / "d.env"
    env.write_text("ALPACA_API_KEY=PKxx\nGITHUB_ACCESS_TOKEN=ghp\n")
    denv.write_text("SESSION_SECRET=abc\nTOTP_SECRET=ZZZ\n")
    monkeypatch.setattr(webapp, "ENV_PATH", env)
    monkeypatch.setattr(webapp, "DASH_ENV_PATH", denv)
    st = webapp.WebInstaller().init_state()
    assert "ALPACA_API_KEY" in st["existing_env_keys"]
    assert "SESSION_SECRET" in st["existing_dash_keys"]
    # values are never exposed — only key names
    blob = repr(st)
    assert "PKxx" not in blob and "abc" not in blob
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_installer_webapp.py::test_init_state_reports_existing_dashboard_keys -v`
Expected: FAIL — `KeyError: 'existing_dash_keys'`

- [ ] **Step 3: Write the implementation**

In `tools/installer/webapp.py` `init_state()`, in the returned dict, change the `existing_env_keys` line and add `existing_dash_keys` right after it:

```python
            "existing_env_keys": sorted(envfile.read_values(ENV_PATH)),
            "existing_dash_keys": sorted(envfile.read_values(DASH_ENV_PATH)),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_installer_webapp.py -v`
Expected: PASS (existing `test_init_state_shape_and_no_secrets` still passes — it checks a subset with `<=`)

- [ ] **Step 5: Commit**

```bash
git add tools/installer/webapp.py tests/test_installer_webapp.py
git commit -m "feat(installer): expose existing dashboard .env keys for re-run safety"
```

---

## Task 8: webapp form — already-set rendering, lift Alpaca gate, review kept-vs-write

**Files:**
- Modify: `tools/installer/webapp.py` — `_PAGE_HTML` JS (`init`, `buildAlpaca`, `grabAlpaca`, `buildGlobals`, `buildDash`, `buildReview`, lines ~554-640)
- Test: `tests/test_installer_webapp.py` (append — assert the HTML contains the new behavior hooks)

This task is JS inside a Python string constant; verification is by asserting the served HTML carries the new logic (the existing test suite already treats `_PAGE_HTML` as a constant).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_webapp.py`:

```python
def test_page_html_has_existing_key_awareness():
    html = webapp._PAGE_HTML
    # already-set markers + the gate-lift + review classification exist
    assert "already set — leave blank to keep" in html
    assert "existing_env_keys" in html and "existing_dash_keys" in html
    assert "Regenerate (replaces existing)" in html
    assert "kept" in html and "will write" in html
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_installer_webapp.py::test_page_html_has_existing_key_awareness -v`
Expected: FAIL — strings absent

- [ ] **Step 3: Write the implementation**

In `tools/installer/webapp.py`, make these edits inside the `_PAGE_HTML` JS:

(a) In `init()`, after `S=await gj('/api/init');`, add helper sets (place right after the existing `$('owner_repo').value=S.owner_repo||'';` line):

```javascript
 window.HAVE=new Set([...(S.existing_env_keys||[]),...(S.existing_dash_keys||[])]);
```

(b) Replace `buildAlpaca()` with a version that marks already-set creds and stops forcing re-entry:

```javascript
function buildAlpaca(){let h='';S.accounts.filter(a=>cfg.modes.includes(a.mode)).forEach(a=>{
 let set=HAVE.has(a.key_env)&&HAVE.has(a.secret_env);
 h+=`<div class="acct"><b>${a.label}</b>${a.is_real?' <span class="tag">REAL MONEY</span>':''}
 ${set?'<div class="muted">✓ already set — leave blank to keep</div>':''}
 <label>${a.key_env}</label><input type="password" data-k="${a.key_env}">
 <label>${a.secret_env}</label><input type="password" data-k="${a.secret_env}">
 <label>${a.url_env}</label><input type="text" data-k="${a.url_env}" value="${a.default_url}">
 <button class="sec" onclick="testAlpaca(this,'${a.key_env}','${a.secret_env}','${a.url_env}')">Test</button>
 <span class="pill" data-t="${a.key_env}"></span></div>`});$('alpaca').innerHTML=h;}
```

(c) Replace `grabAlpaca()` so the hard-gate only fires when creds are neither typed nor already present:

```javascript
function grabAlpaca(){document.querySelectorAll('#alpaca input').forEach(i=>{if(i.value.trim())cfg.bot_env[i.dataset.k]=i.value.trim();});
 for(const a of S.accounts.filter(a=>cfg.modes.includes(a.mode))){
  let have=(cfg.bot_env[a.key_env]&&cfg.bot_env[a.secret_env])||(HAVE.has(a.key_env)&&HAVE.has(a.secret_env));
  if(!have){alert('Fill keys for '+a.mode+' (none on file yet)');return false}}return true;}
```

(d) Replace `buildGlobals()` so already-set tokens show the marker and a deliberate regenerate affordance instead of an auto Generate:

```javascript
function buildGlobals(){let h='';S.global_secrets.forEach(g=>{
 let set=HAVE.has(g.name),gen=g.kind==='generate';
 h+=`<label>${g.name} <span class="muted">${g.desc}</span></label>
 ${set?'<div class="muted">✓ already set — leave blank to keep</div>':''}
 <div class="row"><input type="password" data-g="${g.name}" style="flex:1">
 ${gen?`<button class="sec" onclick="genInto(this,'${g.name}')">${set?'Regenerate (replaces existing)':'Generate'}</button>`:''}</div>`});
 $('globals').innerHTML=h;}
```

(e) In `buildDash()`, for the `else{` branch (plain dashboard secrets), add the same marker. Replace that `else{...}` block with:

```javascript
 else{let gen=g.kind==='generate',set=HAVE.has(g.name);h+=`<label>${g.name} <span class="muted">${g.desc}</span></label>
  ${set?'<div class="muted">✓ already set — leave blank to keep</div>':''}
  <div class="row"><input type="password" data-d="${g.name}" style="flex:1">
  ${gen?`<button class="sec" onclick="genInto2(this,'${g.name}')">${set?'Regenerate (replaces existing)':'Generate'}</button>`:''}</div>`;}});
```

(f) Replace `buildReview()` so each key is labelled kept-vs-write:

```javascript
function buildReview(){let m=v=>!v?'(empty)':v.length<=8?'*'.repeat(v.length):v.slice(0,4)+'…'+v.slice(-4);
 let tag=(k,v)=>v?(' = '+m(v)+'  [will write]'):(HAVE.has(k)?'  [unchanged (kept)]':' = (empty)');
 let L=['fork: '+cfg.owner_repo,'accounts: '+cfg.modes.join(', '),
  'congress: '+cfg.include_congress,'dashboard: '+cfg.do_dashboard,
  'reset bot memory: '+cfg.reset_state,'auto-push to fork: '+cfg.auto_push,
  '','.env keys:'];
 let bk=new Set([...Object.keys(cfg.bot_env),...(S.existing_env_keys||[])]);
 [...bk].sort().forEach(k=>L.push('  '+k+tag(k,cfg.bot_env[k])));
 if(cfg.do_dashboard){L.push('','dashboard/.env keys:');
  let dk=new Set([...Object.keys(cfg.dash_env),...(S.existing_dash_keys||[])]);
  [...dk].sort().forEach(k=>L.push('  '+k+tag(k,cfg.dash_env[k])));}
 $('review').textContent=L.join('\n');}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_installer_webapp.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/installer/webapp.py tests/test_installer_webapp.py
git commit -m "fix(installer): re-run safety — show already-set keys, lift Alpaca gate, kept/write review"
```

---

## Task 9: setup_cronjobs — robust backoff + partial-success exit code

**Files:**
- Modify: `tools/setup_cronjobs.py` — `cronjob_request` (lines ~203-221), `main()` (lines ~287-316), add `__main__` exit handling
- Test: `tests/test_setup_cronjobs.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_setup_cronjobs.py`:

```python
"""cron-job.org scheduler resilience — backoff math + exit classification."""
import importlib

sc = importlib.import_module("tools.setup_cronjobs")


def test_backoff_grows_capped_and_jittered():
    waits = [sc.compute_backoff(a) for a in range(8)]
    assert waits[0] >= 1 and waits[0] <= 4
    assert waits[3] >= waits[1]            # grows
    assert all(w <= sc.BACKOFF_CAP + 2 for w in waits)  # capped (+jitter)


def test_backoff_honors_retry_after():
    assert sc.compute_backoff(0, retry_after="30") == 30.0


def test_exit_code_partial_is_75_only_for_rate_limit():
    assert sc.exit_code_for([]) == 0
    assert sc.exit_code_for([("Job A", "ratelimit")]) == 75
    assert sc.exit_code_for([("Job B", "hard")]) == 1
    assert sc.exit_code_for([("A", "ratelimit"), ("B", "hard")]) == 1


def test_retries_count_is_generous():
    assert sc.RETRIES >= 6
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_setup_cronjobs.py -v`
Expected: FAIL — `AttributeError: module 'tools.setup_cronjobs' has no attribute 'compute_backoff'`

- [ ] **Step 3: Write the implementation**

In `tools/setup_cronjobs.py`:

(a) Ensure `import random` is present at the top (add if absent, next to `import time`).

(b) Add module constants + helpers above `cronjob_request`:

```python
RETRIES = 6
BACKOFF_BASE = 2
BACKOFF_CAP = 32


def compute_backoff(attempt: int, retry_after: str | None = None) -> float:
    """Seconds to wait before the next retry.

    Honors a server ``Retry-After`` (seconds) when present; otherwise
    exponential with a cap plus jitter to avoid lockstep retries.
    """
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            pass
    return min(BACKOFF_BASE * (2 ** attempt), BACKOFF_CAP) + random.uniform(0, 1)


def exit_code_for(failures: list[tuple[str, str]]) -> int:
    """0 = all good; 75 = only recoverable rate-limit partials; 1 = hard."""
    if not failures:
        return 0
    if any(kind == "hard" for _, kind in failures):
        return 1
    return 75


class CronRateLimited(RuntimeError):
    pass
```

(c) Replace `cronjob_request` body's retry loop with backoff that uses
`compute_backoff`, raising `CronRateLimited` when 429 retries are exhausted:

```python
def cronjob_request(method: str, path: str, body: dict | None = None,
                    _retries: int = RETRIES) -> dict:
    """Make a request to cron-job.org API. Retries on 429 with backoff."""
    url = f"{CRONJOB_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    for attempt in range(_retries):
        req = urllib.request.Request(url, data=data, method=method,
                                     headers=CRONJOB_HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = resp.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            if e.code == 429:
                if attempt < _retries - 1:
                    wait = compute_backoff(
                        attempt, e.headers.get("Retry-After"))
                    print(f"  Rate limited (429), retrying in "
                          f"{wait:.1f}s...")
                    time.sleep(wait)
                    continue
                raise CronRateLimited(f"429 exhausted for {method} {path}")
            print(f"  HTTP {e.code}: {e.read().decode()[:300]}",
                  file=sys.stderr)
            raise
    raise CronRateLimited(f"Exhausted retries for {method} {path}")
```

(d) Replace the job loop in `main()` (the `for i, spec in enumerate(JOBS):`
block) so one job's rate-limit doesn't abort the rest, and return the
failure list:

```python
def main() -> int:
    print(f"Configuring cron-job.org for repo {REPO}")
    print()
    existing = list_existing_jobs()
    by_title = {j.get("title"): j for j in existing if j.get("title")}
    titles = {spec["title"] for spec in JOBS}

    failures: list[tuple[str, str]] = []
    for i, spec in enumerate(JOBS):
        sched = (f"hours={spec['hours']} minutes={spec['minutes']} "
                 f"wdays={spec['wdays']}")
        try:
            if spec["title"] in by_title:
                jid = by_title[spec["title"]]["jobId"]
                patch_job(jid, spec)
                print(f"  [OK] Updated '{spec['title']}' (jobId={jid}) "
                      f"-- {sched}")
            else:
                body = build_job_body(spec)
                result = cronjob_request("PUT", "/jobs", body)
                jid = result.get("jobId")
                print(f"  [OK] Created '{spec['title']}' (jobId={jid}) "
                      f"-- {sched}")
        except CronRateLimited:
            print(f"  [RATE-LIMITED] '{spec['title']}' — will need a re-run")
            failures.append((spec["title"], "ratelimit"))
        except Exception as e:  # noqa: BLE001 - record + continue
            print(f"  [FAIL] '{spec['title']}': {e}", file=sys.stderr)
            failures.append((spec["title"], "hard"))
        if i < len(JOBS) - 1:
            time.sleep(2)
    print()

    print("Final state:")
    try:
        for job in list_existing_jobs():
            if job.get("title") in titles:
                print(f"  {job['title']}: enabled={job.get('enabled')} "
                      f"jobId={job.get('jobId')} url={job.get('url')}")
    except Exception:  # listing is best-effort
        pass

    code = exit_code_for(failures)
    if code == 75:
        print(f"\n  {len(failures)} job(s) rate-limited — re-run Apply to "
              "finish the rest (idempotent).")
    elif code == 1:
        print("\n  Some jobs failed for non-rate-limit reasons — see above.",
              file=sys.stderr)
    return code
```

(e) Replace the `if __name__ == "__main__":` block (and the line after it)
with:

```python
if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_setup_cronjobs.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/setup_cronjobs.py tests/test_setup_cronjobs.py
git commit -m "fix(cron): generous jittered backoff + partial-success exit 75 (re-runnable)"
```

---

## Task 10: webapp `_run_cron` — map exit 75 to a recoverable warning

**Files:**
- Modify: `tools/installer/webapp.py` — `_run_cron` (lines ~304-318)
- Test: `tests/test_installer_webapp.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_installer_webapp.py`:

```python
def test_run_cron_classifies_partial_as_warning(monkeypatch):
    inst = webapp.WebInstaller()

    class P:
        returncode = 75
        stdout = "1 job(s) rate-limited — re-run Apply to finish the rest"
        stderr = ""

    monkeypatch.setattr(webapp.subprocess, "run", lambda *a, **k: P())
    inst._run_cron()
    lines = inst.snapshot()["lines"]
    levels = {l["level"] for l in lines}
    assert "warn" in levels and "error" not in levels
    assert any("re-run Apply" in l["msg"] for l in lines)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_installer_webapp.py::test_run_cron_classifies_partial_as_warning -v`
Expected: FAIL — current code logs `error` for any non-zero returncode

- [ ] **Step 3: Write the implementation**

Replace `_run_cron` in `tools/installer/webapp.py` with:

```python
    def _run_cron(self) -> None:
        import sys

        try:
            p = subprocess.run(
                [sys.executable, "tools/setup_cronjobs.py"],
                cwd=ROOT, capture_output=True, text=True, timeout=300,
            )
            if p.returncode == 0:
                level = "ok"
            elif p.returncode == 75:
                level = "warn"  # rate-limited partial — re-run finishes it
            else:
                level = "error"
            self._log(level, "setup_cronjobs.py finished")
            tail = (p.stdout or p.stderr).strip().splitlines()[-6:]
            for line in tail:
                self._log("info", line)
        except Exception as e:
            self._log("error", f"setup_cronjobs.py: {e}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_installer_webapp.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/installer/webapp.py tests/test_installer_webapp.py
git commit -m "fix(installer): treat cron exit 75 as a re-runnable warning, not a failure"
```

---

## Task 11: instructions.md — rewrite Upstash/Marketplace/PAT sections

**Files:**
- Modify: `instructions.md`
- Verify: grep assertions

- [ ] **Step 1: Inspect the current Upstash/Marketplace/PAT text**

Run: `grep -n -i "marketplace\|upstash\|two genuine two-pass\|free tier is enough\|9f\|Workflows" instructions.md`
Record the exact line numbers and surrounding context for each hit (the spec lists approx lines 40, 55, 147-149, 196-198, 730, 834-845).

- [ ] **Step 2: Edit — prerequisites + PAT permissions**

In `instructions.md`:
- In the prerequisites/table area (~line 40, 55): remove the line that says Upstash Redis is connected "via Vercel Marketplace: free tier is enough" and add an Upstash prerequisite row: `Upstash account + Management API key (console → Account → Management API) | The dashboard's Redis store | Required for the dashboard`.
- In the PAT permissions section: change the required fine-grained permission list to include **Workflows: Read and write**, with the note: `(Workflows is required because the installer rewrites and pushes .github/workflows/*.yml.)`

- [ ] **Step 3: Edit — remove two-pass narrative, fix flow**

- Delete the two-pass paragraphs at ~147-149 and ~196-198 ("make the one interactive Upstash Redis connection on vercel.com … then re-run").
- Replace with one sentence: `The dashboard's Redis is provisioned automatically by the installer via the Upstash API — it works on the first Apply, no second pass.`
- Add the cost sentence where Upstash is introduced: `The installer requests Upstash's free plan; if your Upstash account requires a card it falls back to pay-as-you-go (~$0–$1/mo for this dashboard) and warns you in the log.`
- Replace section **9f** ("Add the cloud database (Upstash Redis)" / "Browse Marketplace") body with: `The installer provisions this automatically from your Upstash email + Management API key — no manual Vercel Storage / Marketplace step. Nothing to do here.`

- [ ] **Step 4: Verify the rewrite**

Run: `grep -n -i "marketplace" instructions.md`
Expected: no remaining instruction telling the user to connect Upstash via the Vercel Marketplace (any surviving "marketplace" mention must be historical/explanatory only — confirm by reading each hit).

Run: `grep -n -i "Workflows: Read and write\|provisioned automatically by the installer\|pay-as-you-go" instructions.md`
Expected: all three present.

- [ ] **Step 5: Commit**

```bash
git add instructions.md
git commit -m "docs(instructions): Upstash via API (no Marketplace two-pass); add Workflows PAT scope"
```

---

## Task 12: Full suite green + final commit

**Files:** none (verification only)

- [ ] **Step 1: Run the entire installer + cron test suite**

Run: `python -m pytest tests/test_installer_upstash.py tests/test_installer_spec.py tests/test_installer_webapp.py tests/test_installer_fork.py tests/test_setup_cronjobs.py tests/test_installer_envfile.py tests/test_installer_wizard.py -v`
Expected: ALL PASS. If any pre-existing installer test regressed, fix the regression before proceeding (do not modify a test to pass unless the test encoded the now-removed two-pass behavior — in which case update it to the new contract and note it in the commit).

- [ ] **Step 2: Run the broader bot suite for collateral safety**

Run: `python -m pytest tests/ -q`
Expected: No new failures versus the pre-change baseline (380 pytest baseline per CLAUDE.md; the installer tasks add tests, none should remove coverage).

- [ ] **Step 3: Commit any regression fixes**

```bash
git add -A
git commit -m "test(installer): reconcile suite with v2 hardening (Upstash + 4 fixes)"
```

(If Step 1 and Step 2 were clean with everything already committed in Tasks 1–11, skip this commit — there is nothing to commit.)

---

## Task 13: Optional "Re-run Apply" button (post-final-review addition)

**Added after the holistic final review**, at the user's request, while finishing the branch. Not part of the original 12-task spec; coherent with the re-run-safety theme (Section 3) and the cron-429 partial path (Section 5, exit 75 → "re-run Apply to finish the rest"). It is a convenience affordance only — it does NOT reintroduce the eliminated mandatory two-pass.

**Files:** `tools/installer/webapp.py` (`start_apply`, `_PAGE_HTML` `#s7`, `apply()` JS); `tests/test_installer_webapp.py`.

- `start_apply` resets `progress`/`done`/`dashboard_url` under `self._lock` before spawning the apply thread, so a second Apply renders cleanly (synchronous reset; first-run behavior unchanged since it re-establishes the same empties `__init__` set).
- `#s7` progress screen gains `<button class="sec" onclick="show(6)">Re-run Apply</button>` (returns to the review step whose existing Apply button drives `apply()`; no new API endpoint). Finish button `&`→`&amp;`.
- `apply()` clears `#plog` and `#dashlink` before re-applying so stale output/links don't flash.
- Tests: deterministic `test_start_apply_resets_state_for_rerun` (thread stubbed to isolate the synchronous-reset invariant — no timing dependence) + `test_progress_screen_has_rerun_button`.

Commits: `589a3a7` (feature) → `f476ae8` (review fixes: deterministic test + stale-output clear). Spec + code-quality reviewed and approved; full suite 463 passed, 0 regressions.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented by |
|---|---|
| §1 Upstash automation (module, spec.py, apply flow) | Tasks 1, 2, 3, 4 |
| §1 Defaults (DB name `tradingbot-dashboard-kv`, region `us-east-1`) | Task 1 (`DB_NAME`, `DEFAULT_REGION`) |
| §1 free→payg warn+proceed | Task 1 (`find_or_create`), Task 4 (warn log) |
| §2 Auto-push auth (no `.git/config` leak) | Task 5 |
| §3 Re-run footgun (already-set, gate lift, review) | Tasks 7, 8 |
| §4 PAT Workflows (docs + actionable failure) | Tasks 6, 11 |
| §5 cron 429 resilience (backoff, resume, honest status) | Tasks 9, 10 |
| §6 instructions.md rewrite | Task 11 |
| §7 Testing | Tasks 1–10 (TDD per task), Task 12 (full suite) |

All spec sections map to tasks. The §4 deviation (failure-classification instead of an unreliable pre-flight probe) is documented in the header note for plan review.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases"/"similar to Task N". Every code step shows complete code; every command shows expected output.

**3. Type consistency:** `UpstashProvisioner(email, api_key, *, dry_run)` / `find_or_create() -> (dict, str)` / `kv_env(db) -> dict` consistent across Tasks 1, 2, 4. `_deploy_dashboard(self, cfg, dash_env, bot_env, owner_repo)` signature consistent between the Task 4 call site and definition and the Task 4 test. `_git_push_fork(self, owner_repo, token, dry)` consistent across Tasks 5, 6 and their tests. `is_workflow_scope_error(text)` consistent in Task 6. `compute_backoff`/`exit_code_for`/`CronRateLimited`/`RETRIES`/`BACKOFF_CAP` consistent across Task 9 and its test, and `exit 75` consistent between Task 9 (`exit_code_for`) and Task 10 (`_run_cron` mapping).
