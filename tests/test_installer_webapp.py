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
    inst = webapp.WebInstaller()
    inst._apply({
        "dry_run": True,
        "owner_repo": "bob/fork",
        "modes": ["conservative"],
        "include_congress": False,
        "do_dashboard": False,
        "bot_env": {"ALPACA_API_KEY": "PKxx", "BOT_PUSH_TOKEN": "deadbeef"},
        "dash_env": {},
    })
    snap = inst.snapshot()
    assert snap["done"] is True
    assert not (tmp_path / ".env").exists()
    text = " ".join(l["msg"] for l in snap["lines"])
    assert "would set ALPACA_API_KEY" in text
    assert "DRY-RUN would set" in text  # secrets-push plan
    assert "PKxx" not in text  # value never echoed raw


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
