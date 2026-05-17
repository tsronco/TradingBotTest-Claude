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
    inst._git_push_fork("bob/fork", dry=True)
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
    inst._git_push_fork("bob/fork", dry=False)

    add = next(a for a in seen if a[:2] == ["git", "add"])
    assert "-A" not in add and "." not in add[2:]
    assert ".env" not in " ".join(add)  # the secret file is never staged
    assert any("setup_cronjobs.py" in x for x in add)
    assert any(".github/workflows/tsla.yml" in x for x in add)
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
    inst._git_push_fork("bob/fork", dry=False)
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
