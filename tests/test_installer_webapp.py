"""Web installer: catalog shape, generators, dry-run safety, token gate."""
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from tools.installer import webapp


def test_init_state_shape_and_no_secrets():
    st = webapp.WebInstaller().init_state()
    assert {"owner_repo", "accounts", "global_secrets", "dashboard_secrets",
            "congress_env", "data_url", "existing_env_keys"} <= set(st)
    modes = {a["mode"] for a in st["accounts"]}
    assert "conservative" in modes and "live" in modes
    # catalog is metadata only: env-var NAMES, never collected values
    assert "bot_env" not in st and "dash_env" not in st
    assert isinstance(st["existing_env_keys"], list)  # key names, not values
    acc = st["accounts"][0]
    assert set(acc) == {"mode", "label", "is_real", "key_env",
                        "secret_env", "url_env", "default_url", "webhooks"}


def test_generate_token_and_totp():
    t = webapp._generate("token")
    assert len(t["value"]) == 64
    tp = webapp._generate("totp")
    assert tp["secret"] and tp["otpauth"].startswith("otpauth://")
    assert "unknown" in webapp._generate("nope")["error"]


def test_generate_backup_gracefully_nulls(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "DASH_DIR", tmp_path)  # no generator script
    assert webapp._generate("backup") == {"codes": None}


def test_dry_run_apply_writes_nothing_and_logs_plan(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "ENV_PATH", tmp_path / ".env")
    monkeypatch.setattr(webapp, "DASH_ENV_PATH", tmp_path / "d.env")
    monkeypatch.setattr(webapp, "ROOT", tmp_path)  # reset glob hits nothing
    inst = webapp.WebInstaller()
    inst._apply({
        "dry_run": True,
        "owner_repo": "bob/fork",
        "modes": ["conservative"],
        "include_congress": False,
        "do_dashboard": False,
        "reset_state": True,
        "bot_env": {"ALPACA_API_KEY": "PKxx", "BOT_PUSH_TOKEN": "deadbeef",
                    "GITHUB_ACCESS_TOKEN": "ghp_x"},
        "dash_env": {},
    })
    snap = inst.snapshot()
    assert snap["done"] is True
    assert not (tmp_path / ".env").exists()
    text = " ".join(l["msg"] for l in snap["lines"])
    assert "would set ALPACA_API_KEY" in text
    assert "DRY-RUN would set" in text  # secrets-push plan
    assert "DRY-RUN would enable GitHub Actions" in text  # actions plan
    assert "PKxx" not in text  # value never echoed raw


def test_reset_state_files_blanks_only_on_real_run(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    (tmp_path / "strategy_state.json").write_text('{"TSLA": {"qty": 10}}')
    (tmp_path / "wheel_state_aggressive.json").write_text('{"BAC": 1}')
    (tmp_path / "unrelated.json").write_text('{"keep": 1}')

    names = webapp._reset_state_files(dry=True)
    assert set(names) == {"strategy_state.json", "wheel_state_aggressive.json"}
    assert "qty" in (tmp_path / "strategy_state.json").read_text()  # untouched

    webapp._reset_state_files(dry=False)
    assert (tmp_path / "strategy_state.json").read_text() == "{}\n"
    assert (tmp_path / "wheel_state_aggressive.json").read_text() == "{}\n"
    assert "keep" in (tmp_path / "unrelated.json").read_text()  # not in glob


def test_enable_actions_api_contract(monkeypatch):
    from tools.installer import github_api

    gh = github_api.GitHubSecrets("bob/fork", "ghp_x")
    assert "DRY-RUN" in github_api.GitHubSecrets(
        "bob/fork", "t", dry_run=True).enable_actions()

    calls = {}

    class Resp:
        def __init__(self, code):
            self.status_code = code
            self.text = "nope"

    def fake_put(url, **kw):
        calls["url"] = url
        calls["body"] = kw["json"]
        return Resp(204)

    monkeypatch.setattr(github_api.requests, "put", fake_put)
    assert "enabled" in gh.enable_actions()
    assert calls["url"].endswith("/repos/bob/fork/actions/permissions")
    assert calls["body"] == {"enabled": True, "allowed_actions": "all"}

    monkeypatch.setattr(github_api.requests, "put", lambda *a, **k: Resp(403))
    with pytest.raises(github_api.GitHubError, match="Administration"):
        gh.enable_actions()


def test_enable_actions_degrades_without_token():
    inst = webapp.WebInstaller()
    inst._enable_actions("bob/fork", {}, dry=False)  # no GITHUB_ACCESS_TOKEN
    msgs = " ".join(l["msg"] for l in inst.snapshot()["lines"])
    assert "enable Actions by hand" in msgs  # graceful, not a crash


def _fork_tree(tmp_path):
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "setup_cronjobs.py").write_text("REPO='x'\n")
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    (tmp_path / ".github" / "workflows" / "tsla.yml").write_text("on: x\n")
    (tmp_path / "strategy_state.json").write_text("{}\n")
    (tmp_path / ".env").write_text("SECRET=should_never_be_staged\n")


def test_git_push_dry_run_runs_no_git(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    _fork_tree(tmp_path)
    import subprocess
    monkeypatch.setattr(subprocess, "run",
                        lambda *a, **k: pytest.fail("git ran in dry mode"))
    inst = webapp.WebInstaller()
    inst._git_push_fork("bob/fork", "", dry=True)
    assert "Would commit & push" in inst.snapshot()["lines"][0]["msg"]


def test_git_push_stages_allowlist_only_and_pushes(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    _fork_tree(tmp_path)
    seen = []

    class R:
        def __init__(self, code=0, out=""):
            self.returncode, self.stdout, self.stderr = code, out, ""

    def fake_run(argv, **kw):
        seen.append(argv)
        sub = argv[1:]
        if "rev-parse" in sub:
            return R(out="main\n")
        if "config" in sub:
            return R(out="me@example.com\n")  # identity present
        if "diff" in sub:
            return R(code=1)  # there ARE staged changes
        return R(code=0)

    import subprocess
    monkeypatch.setattr(subprocess, "run", fake_run)
    inst = webapp.WebInstaller()
    inst._git_push_fork("bob/fork", "", dry=False)

    add = next(a for a in seen if a[:2] == ["git", "add"])
    assert "-A" not in add and "." not in add[2:]
    assert ".env" not in " ".join(add)  # the secret file is never staged
    assert any("setup_cronjobs.py" in x for x in add)
    assert any(x.replace("\\", "/").endswith(".github/workflows/tsla.yml")
               or ".github/workflows/tsla.yml" in x.replace("\\", "/")
               for x in add)
    assert ["git", "push", "-u", "origin", "main"] in seen
    assert "pushed fork config" in \
        " ".join(l["msg"] for l in inst.snapshot()["lines"])


def test_git_push_failure_degrades_to_manual(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    _fork_tree(tmp_path)
    import subprocess
    import time

    class R:
        def __init__(self, code, out=""):
            self.returncode, self.stdout, self.stderr = code, out, ""

    def fake_run(argv, **kw):
        sub = argv[1:]
        if "rev-parse" in sub:
            return R(0, "main\n")
        if "config" in sub:
            return R(0, "")  # no identity -> -c overrides used
        if "diff" in sub:
            return R(1)
        if "push" in sub:
            return R(1)  # push always fails
        return R(0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(time, "sleep", lambda *_: None)  # no real backoff
    inst = webapp.WebInstaller()
    inst._git_push_fork("bob/fork", "", dry=False)
    msg = " ".join(l["msg"] for l in inst.snapshot()["lines"])
    assert "Auto-push failed" in msg and "git push -u origin main" in msg


@pytest.fixture
def live_server():
    inst = webapp.WebInstaller()
    token = "test-token-123"
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), webapp._make_handler(inst, token))
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    port = httpd.server_address[1]
    yield port, token
    httpd.shutdown()
    httpd.server_close()


def _get(port, path, token=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
    if token:
        req.add_header("X-Installer-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_token_gate_blocks_without_token(live_server):
    port, token = live_server
    code, _ = _get(port, "/api/init")
    assert code == 403
    code, _ = _get(port, "/api/init", token="wrong")
    assert code == 403


def test_authed_requests_work(live_server):
    port, token = live_server
    code, body = _get(port, "/api/init", token=token)
    assert code == 200
    assert "accounts" in json.loads(body)
    code, html = _get(port, f"/?t={token}", token=token)
    assert code == 200 and b"TradingBot setup" in html
    # token also accepted via query string alone
    code, _ = _get(port, f"/api/progress?t={token}")
    assert code == 200


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


def test_deploy_dashboard_errors_when_upstash_creds_missing(monkeypatch):
    from tools.installer import vercel_cli

    monkeypatch.setattr(vercel_cli, "available", lambda: True)
    called = []
    monkeypatch.setattr(vercel_cli, "link",
                        lambda *a: called.append("link") or (True, "x"))

    inst = webapp.WebInstaller()
    inst._deploy_dashboard({"vercel_project": "p"}, {"SESSION_SECRET": "s"},
                           {}, "bob/fork")
    msgs = " ".join(l["msg"] for l in inst.snapshot()["lines"])
    assert "Upstash email" in msgs and "required" in msgs
    assert "link" not in called  # bailed before any Vercel work


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
    blob = repr(st)
    assert "PKxx" not in blob and "abc" not in blob


def test_page_html_has_existing_key_awareness():
    html = webapp._PAGE_HTML
    assert "already set — leave blank to keep" in html
    assert "existing_env_keys" in html and "existing_dash_keys" in html
    assert "Regenerate (replaces existing)" in html
    assert "kept" in html and "will write" in html


def test_totp_and_backup_branches_have_regen_awareness():
    html = webapp._PAGE_HTML
    # the genTotp and genBackup buttons must be able to show the regen label
    import re
    totp_seg = html[html.index("genTotp(this)") - 400:html.index("genTotp(this)") + 200]
    backup_seg = html[html.index("genBackup(this)") - 400:html.index("genBackup(this)") + 200]
    assert "Regenerate (replaces existing)" in totp_seg
    assert "already set — leave blank to keep" in totp_seg
    assert "Regenerate (replaces existing)" in backup_seg
    assert "already set — leave blank to keep" in backup_seg


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


def test_start_apply_resets_state_for_rerun(monkeypatch, tmp_path):
    monkeypatch.setattr(webapp, "ENV_PATH", tmp_path / ".env")
    monkeypatch.setattr(webapp, "DASH_ENV_PATH", tmp_path / "d.env")
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    inst = webapp.WebInstaller()
    cfg = {"dry_run": True, "owner_repo": "bob/fork", "modes": ["conservative"],
           "include_congress": False, "do_dashboard": False, "reset_state": False,
           "bot_env": {"ALPACA_API_KEY": "PKx"}, "dash_env": {}}
    # First pass run synchronously (suite style) to populate state.
    inst._apply(cfg)
    first = inst.snapshot()
    assert first["done"] is True and len(first["lines"]) > 0
    inst.dashboard_url = "https://stale.example"  # simulate prior-run leftover
    # start_apply must reset progress/done/dashboard_url SYNCHRONOUSLY,
    # before the spawned thread can append anything.
    # Suppress the background thread so the "immediately after" observation is
    # race-free — the invariant under test is that the RESET happens inside
    # start_apply (before thread spawn), not that the thread eventually finishes.
    import threading as _threading
    class _NoOpThread:
        def __init__(self, target=None, args=(), daemon=False): pass
        def start(self): pass
    monkeypatch.setattr(_threading, "Thread", _NoOpThread)
    inst.start_apply(cfg)
    immediately = inst.snapshot()
    assert immediately["done"] is False           # reset, not stale True
    assert immediately["lines"] == []             # no stale accumulation
    assert immediately["dashboard_url"] == ""     # prior URL cleared


def test_progress_screen_has_rerun_button():
    html = webapp._PAGE_HTML
    assert 'onclick="show(6)"' in html
    assert "Re-run Apply" in html


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
    alpaca_calls = []
    monkeypatch.setattr(webapp.validate, "check_alpaca",
                        lambda k, s, u: alpaca_calls.append((k, s, u)) or (True, "ok"))
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
    assert alpaca_calls and alpaca_calls[0][0] == "PKlive"  # health check used file value


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
